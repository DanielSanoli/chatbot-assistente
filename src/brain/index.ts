import type { Store } from "../store/index.js";
import { createAgent, type Agent, type AgentDeps } from "./agent.js";
import { createAnthropicClient, type ClaudeClient } from "./claude.js";

export { createAgent, type Agent, type AgentTurnResult } from "./agent.js";
export { buildSystemPrompt } from "./prompt.js";
export {
  buscarServico,
  listarServicos,
  infoLocal,
  infoPagamento,
  buscarFaq,
  acionarHandoff,
  PRECO_SOB_AVALIACAO,
} from "./tools.js";
export type { ClaudeClient } from "./claude.js";

export type BrainDeps = {
  store: Store;
  apiKey?: string;
  claude?: ClaudeClient;
  model?: string;
  getConfig?: AgentDeps["getConfig"];
  now?: AgentDeps["now"];
};

export function createBrain(deps: BrainDeps) {
  const claude =
    deps.claude ??
    createAnthropicClient(
      deps.apiKey ??
        process.env.ANTHROPIC_API_KEY ??
        (() => {
          throw new Error("ANTHROPIC_API_KEY não configurada");
        })(),
    );

  const agent = createAgent({
    store: deps.store,
    claude,
    model: deps.model,
    getConfig: deps.getConfig,
    now: deps.now,
  });

  return {
    name: "brain" as const,
    ready: true,
    agent,
    handleText: (waId: string, text: string) =>
      agent.handleUserMessage(waId, text),
  };
}
