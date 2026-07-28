import type { MessageParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import { ConfigService } from "../config/index.js";
import type { ClientConfig } from "../config/schema.js";
import { maskPhone } from "../channel/mask.js";
import { logEvent, type Store } from "../store/index.js";
import { getConversationWindow } from "../store/history.js";
import type { ClaudeClient } from "./claude.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  ANTHROPIC_TOOLS,
  PRECO_SOB_AVALIACAO,
  executeTool,
  type ToolName,
} from "./tools.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 6;

export type AgentTurnResult = {
  reply: string;
  ferramentas: string[];
  handoff: boolean;
  respostaSemFonte: boolean;
};

export type AgentDeps = {
  store: Store;
  claude: ClaudeClient;
  getConfig?: () => ClientConfig;
  model?: string;
  now?: () => Date;
};

function isToolName(name: string): name is ToolName {
  return (
    name === "buscar_servico" ||
    name === "listar_servicos" ||
    name === "info_local" ||
    name === "info_pagamento" ||
    name === "buscar_faq" ||
    name === "acionar_handoff"
  );
}

function historyToMessages(
  history: Array<{ direcao: "in" | "out"; texto: string }>,
): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const item of history) {
    const role = item.direcao === "in" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n${item.texto}`;
      continue;
    }
    messages.push({ role, content: item.texto });
  }

  // Claude exige que a conversa termine em user para gerar a próxima resposta.
  // A mensagem atual já está no histórico como "in".
  if (messages.length === 0) {
    return [{ role: "user", content: "Olá" }];
  }
  if (messages[messages.length - 1]?.role === "assistant") {
    messages.push({ role: "user", content: "(continue)" });
  }
  return messages;
}

function extractText(content: ClaudeCreateResultContent): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

type ClaudeCreateResultContent = Awaited<
  ReturnType<ClaudeClient["createMessage"]>
>["content"];

function shouldForceHandoff(toolName: string, result: unknown): string | null {
  if (toolName !== "buscar_servico" || !result || typeof result !== "object") {
    return null;
  }
  const data = result as {
    encontrado?: boolean;
    preco_status?: string;
    marcador?: string;
  };
  if (data.encontrado === false) {
    return "servico_inexistente";
  }
  if (
    data.preco_status === PRECO_SOB_AVALIACAO ||
    data.marcador === PRECO_SOB_AVALIACAO
  ) {
    return "preco_nao_informado";
  }
  return null;
}

export function createAgent(deps: AgentDeps) {
  const getConfig = deps.getConfig ?? (() => ConfigService.get());
  const model = deps.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

  async function handleUserMessage(
    waId: string,
    _userText: string,
  ): Promise<AgentTurnResult> {
    const config = getConfig();
    const system = buildSystemPrompt(config);
    const now = deps.now?.() ?? new Date();

    const history = getConversationWindow(deps.store, waId, { now });
    const messages = historyToMessages(history);

    const ferramentas: string[] = [];
    let handoff = false;
    let handoffReply: string | null = null;
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await deps.claude.createMessage({
        model,
        system,
        messages,
        tools: ANTHROPIC_TOOLS,
        max_tokens: 1024,
      });

      const toolUses = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );

      if (toolUses.length === 0) {
        finalText = extractText(response.content);
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
      }> = [];

      for (const toolUse of toolUses) {
        const name = toolUse.name;
        ferramentas.push(name);

        if (!isToolName(name)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ erro: `ferramenta desconhecida: ${name}` }),
          });
          continue;
        }

        const input =
          toolUse.input && typeof toolUse.input === "object"
            ? (toolUse.input as Record<string, unknown>)
            : {};
        const result = executeTool(config, name, input);

        if (name === "acionar_handoff") {
          handoff = true;
          const data = result as { mensagem: string };
          handoffReply = data.mensagem;
        }

        const forceReason = shouldForceHandoff(name, result);
        if (forceReason) {
          handoff = true;
          const forced = executeTool(config, "acionar_handoff", {
            motivo: forceReason,
          }) as { mensagem: string };
          handoffReply = forced.mensagem;
          ferramentas.push("acionar_handoff");
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });

      if (handoff && handoffReply) {
        finalText = handoffReply;
        break;
      }

      if (response.stop_reason === "end_turn") {
        finalText = extractText(response.content);
        break;
      }
    }

    if (!finalText && handoffReply) {
      finalText = handoffReply;
    }
    if (!finalText) {
      finalText = config.handoff.mensagem;
      handoff = true;
      ferramentas.push("acionar_handoff");
    }

    const respostaSemFonte = ferramentas.length === 0;

    logEvent(deps.store, "brain.turno", {
      wa_id_masked: maskPhone(waId),
      ferramentas,
      handoff,
      resposta_sem_fonte: respostaSemFonte,
    });

    if (respostaSemFonte) {
      logEvent(deps.store, "resposta_sem_fonte", {
        wa_id_masked: maskPhone(waId),
        reply_length: finalText.length,
      });
    }

    return {
      reply: finalText,
      ferramentas,
      handoff,
      respostaSemFonte,
    };
  }

  return {
    handleUserMessage,
    buildSystemPrompt: () => buildSystemPrompt(getConfig()),
  };
}

export type Agent = ReturnType<typeof createAgent>;
