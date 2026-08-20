import type { MessageParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import { DateTime } from "luxon";
import type { CalendarClient } from "../calendar/google.js";
import { CalendarUnavailable } from "../calendar/google.js";
import { ConfigService } from "../config/index.js";
import type { ClientConfig } from "../config/schema.js";
import { maskPhone } from "../channel/mask.js";
import {
  logEvent,
  precisaEnviarAvisoLgpd,
  type Store,
} from "../store/index.js";
import { getConversationWindow } from "../store/history.js";
import { ANTECEDENCIA_INSUFICIENTE } from "./appointments.js";
import { expirePropostoIfNeeded } from "./booking.js";
import type { ClaudeClient } from "./claude.js";
import {
  detectExplicitHandoff,
  detectUrgency,
  isMutedEmHumano,
  transferToHuman,
} from "./handoff.js";
import {
  DELETE_CONFIRMATION_MESSAGE,
  deleteUserData,
  detectDeleteRequest,
} from "./privacy.js";
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
  /** null = bot silenciado (EM_HUMANO); servidor não deve enviar nada. */
  reply: string | null;
  muted: boolean;
  ferramentas: string[];
  handoff: boolean;
  respostaSemFonte: boolean;
  /**
   * true = `reply` começa com o aviso de LGPD e ele ainda NÃO foi marcado como
   * entregue. Quem envia deve chamar marcarAvisoLgpdEntregue após o envio dar
   * certo — marcar antes faz o paciente perder o aviso se a Graph API falhar.
   */
  avisoLgpdPendente: boolean;
};

export type AgentDeps = {
  store: Store;
  claude: ClaudeClient;
  calendar: CalendarClient;
  notifyHuman: (numeroHumano: string, resumo: string) => Promise<void>;
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
    name === "acionar_handoff" ||
    name === "registrar_falha_entendimento" ||
    name === "propor_horarios" ||
    name === "confirmar_agendamento" ||
    name === "consultar_agendamento" ||
    name === "cancelar_agendamento" ||
    name === "remarcar_agendamento"
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

const FERRAMENTAS_DE_AGENDA = new Set([
  "propor_horarios",
  "confirmar_agendamento",
  "remarcar_agendamento",
  "cancelar_agendamento",
]);

function shouldForceHandoff(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;

  if (FERRAMENTAS_DE_AGENDA.has(toolName)) {
    const motivo = (result as { motivo?: string }).motivo;

    // Serviço que a casa informa mas não marca sozinha. O freio já existe em
    // booking.ts (não chama o Calendar), mas sem isto a conversa termina no
    // texto do modelo — que pode simplesmente não acionar o handoff.
    // Hoje passa despercebido porque todo agendavel:false também tem
    // preco:null; some no primeiro serviço com preço E agenda manual.
    if (motivo === "servico_nao_agendavel") {
      return "servico_nao_agendavel";
    }

    // Cancelar/remarcar em cima da hora é decisão da recepção (multa, encaixe).
    if (motivo === ANTECEDENCIA_INSUFICIENTE) {
      return toolName === "cancelar_agendamento"
        ? "cancelamento_em_cima_da_hora"
        : "remarcacao_em_cima_da_hora";
    }

    return null;
  }

  if (toolName !== "buscar_servico") return null;

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
    userText: string,
  ): Promise<AgentTurnResult> {
    // LGPD — direito de exclusão. Precede TUDO, inclusive isMutedEmHumano:
    // uma conversa em handoff fica muda por 12h, e o paciente não pode ficar
    // meio dia sem conseguir exercer o direito. Também não é caso de handoff.
    if (detectDeleteRequest(userText)) {
      const removed = deleteUserData(deps.store, waId);
      logEvent(deps.store, "lgpd.exclusao_solicitada", {
        wa_id_masked: maskPhone(waId),
        mensagens_removidas: removed.mensagens,
      });
      return {
        reply: DELETE_CONFIRMATION_MESSAGE,
        muted: false,
        ferramentas: [],
        handoff: false,
        respostaSemFonte: false,
        avisoLgpdPendente: false,
      };
    }

    const config = getConfig();
    const nowDate = deps.now?.() ?? new Date();
    const agora = DateTime.fromJSDate(nowDate).setZone(config.cliente.timezone);

    const toolCtxBase = {
      config,
      store: deps.store,
      calendar: deps.calendar,
      waId,
      agora,
      userText,
      notifyHuman: deps.notifyHuman,
    };

    // (mute) EM_HUMANO por 12h — bot não responde nada.
    if (isMutedEmHumano(deps.store, waId, config, agora)) {
      logEvent(deps.store, "handoff.mensagem_ignorada", {
        wa_id_masked: maskPhone(waId),
      });
      return {
        reply: null,
        muted: true,
        ferramentas: [],
        handoff: true,
        respostaSemFonte: false,
        avisoLgpdPendente: false,
      };
    }

    // Prefixa o aviso, mas NÃO marca como enviado: quem marca é o canal, depois
    // de o envio dar certo (marcarAvisoLgpdEntregue). Marcar aqui faria o
    // paciente perder o aviso para sempre se a Graph API falhasse no meio.
    let avisoLgpdPendente = false;
    const withLgpdAviso = (reply: string): string => {
      if (!precisaEnviarAvisoLgpd(deps.store, waId)) {
        return reply;
      }
      avisoLgpdPendente = true;
      return `${config.privacidade.aviso_primeira_mensagem}\n\n${reply}`;
    };

    // Urgência clínica — prioridade máxima, sem agendar.
    if (detectUrgency(userText)) {
      const transfer = await transferToHuman({
        ...toolCtxBase,
        motivo: "urgencia_clinica",
        intencao: userText,
      });
      return {
        reply: withLgpdAviso(transfer.clientMessage),
        muted: false,
        ferramentas: ["acionar_handoff"],
        handoff: true,
        respostaSemFonte: false,
        avisoLgpdPendente,
      };
    }

    // Gatilho explícito de handoff.
    const explicit = detectExplicitHandoff(
      userText,
      config.handoff.gatilhos_explicitos,
    );
    if (explicit) {
      const transfer = await transferToHuman({
        ...toolCtxBase,
        motivo: `gatilho_explicito:${explicit}`,
        intencao: userText,
      });
      return {
        reply: withLgpdAviso(transfer.clientMessage),
        muted: false,
        ferramentas: ["acionar_handoff"],
        handoff: true,
        respostaSemFonte: false,
        avisoLgpdPendente,
      };
    }

    expirePropostoIfNeeded({
      store: deps.store,
      config,
      calendar: deps.calendar,
      waId,
      agora,
      userText,
    });

    const system = buildSystemPrompt(config);
    const history = getConversationWindow(deps.store, waId, {
      now: nowDate,
    });
    const messages = historyToMessages(history);

    const ferramentas: string[] = [];
    let handoff = false;
    let handoffReply: string | null = null;
    let finalText = "";
    let bookingClientMessage: string | null = null;

    try {
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
              content: JSON.stringify({
                erro: `ferramenta desconhecida: ${name}`,
              }),
            });
            continue;
          }

          const input =
            toolUse.input && typeof toolUse.input === "object"
              ? (toolUse.input as Record<string, unknown>)
              : {};

          let result: unknown;
          try {
            result = await executeTool(toolCtxBase, name, input);
          } catch (err) {
            const motivo =
              err instanceof CalendarUnavailable
                ? "erro_interno:CalendarUnavailable"
                : `erro_interno:${err instanceof Error ? err.name : "Error"}`;
            const transfer = await transferToHuman({
              ...toolCtxBase,
              motivo,
              intencao: userText,
            });
            return {
              reply: withLgpdAviso(transfer.clientMessage),
              muted: false,
              ferramentas: [...ferramentas, "acionar_handoff"],
              handoff: true,
              respostaSemFonte: false,
              avisoLgpdPendente,
            };
          }

          if (
            (name === "acionar_handoff" ||
              name === "registrar_falha_entendimento") &&
            result &&
            typeof result === "object" &&
            (result as { handoff?: boolean }).handoff === true
          ) {
            handoff = true;
            handoffReply = (result as { mensagem: string }).mensagem;
          }

          // Confirmação e cancelamento devolvem o texto exato a enviar: são os
          // dois momentos em que a mensagem precisa bater com o que foi gravado
          // na agenda, sem reescrita do modelo.
          if (
            result &&
            typeof result === "object" &&
            typeof (result as { mensagem_cliente?: string }).mensagem_cliente ===
              "string" &&
            ((name === "confirmar_agendamento" &&
              (result as { agendado?: boolean }).agendado === true) ||
              (name === "cancelar_agendamento" &&
                (result as { cancelado?: boolean }).cancelado === true))
          ) {
            bookingClientMessage = (result as { mensagem_cliente: string })
              .mensagem_cliente;
          }

          const forceReason = shouldForceHandoff(name, result);
          if (forceReason) {
            const forced = await executeTool(toolCtxBase, "acionar_handoff", {
              motivo: forceReason,
              intencao: userText,
            });
            handoff = true;
            handoffReply = (forced as { mensagem: string }).mensagem;
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

        if (bookingClientMessage) {
          finalText = bookingClientMessage;
          break;
        }

        if (response.stop_reason === "end_turn") {
          finalText = extractText(response.content);
          break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errName = err instanceof Error ? err.name : "Error";
      const motivo =
        err instanceof CalendarUnavailable
          ? "erro_interno:CalendarUnavailable"
          : `erro_interno:${errName}`;
      logEvent(deps.store, "brain.claude_error", {
        wa_id_masked: maskPhone(waId),
        error_name: errName,
        error: errMsg.slice(0, 400),
        model,
      });
      const transfer = await transferToHuman({
        ...toolCtxBase,
        motivo,
        intencao: userText,
      });
      return {
        reply: withLgpdAviso(transfer.clientMessage),
        muted: false,
        ferramentas: [...ferramentas, "acionar_handoff"],
        handoff: true,
        respostaSemFonte: false,
        avisoLgpdPendente,
      };
    }

    if (!finalText && handoffReply) {
      finalText = handoffReply;
    }
    if (!finalText && bookingClientMessage) {
      finalText = bookingClientMessage;
    }
    if (!finalText) {
      const transfer = await transferToHuman({
        ...toolCtxBase,
        motivo: "erro_interno:resposta_vazia",
        intencao: userText,
      });
      finalText = transfer.clientMessage;
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
        user_text: userText.slice(0, 280),
        reply_length: finalText.length,
      });
    }

    return {
      reply: withLgpdAviso(finalText),
      muted: false,
      ferramentas,
      handoff,
      respostaSemFonte,
      avisoLgpdPendente,
    };
  }

  return {
    handleUserMessage,
    buildSystemPrompt: () => buildSystemPrompt(getConfig()),
  };
}

export type Agent = ReturnType<typeof createAgent>;
