import type { CalendarClient } from "../calendar/google.js";
import { createGoogleCalendarClient } from "../calendar/google.js";
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
  PRECO_SOB_AVALIACAO,
} from "./tools.js";
export {
  proporHorarios,
  confirmarAgendamento,
  isAmbiguousSlotChoice,
  isFullName,
  expirePropostoIfNeeded,
  formatDataHora,
} from "./booking.js";
export {
  consultarAgendamentos,
  cancelarAgendamento,
  remarcarAgendamento,
  ANTECEDENCIA_INSUFICIENTE,
  PENDENCIA_TTL_MINUTES,
} from "./appointments.js";
export {
  transferToHuman,
  detectUrgency,
  detectExplicitHandoff,
  isMutedEmHumano,
  recordDemandaNaoAtendida,
  registerUnderstandingFailure,
  clientHandoffMessage,
  buildHumanSummary,
} from "./handoff.js";
export {
  detectDeleteRequest,
  deleteUserData,
  scrubUserTextFromEvents,
  marcarAvisoLgpdEntregue,
  DELETE_CONFIRMATION_MESSAGE,
  TEXTO_EXPURGADO,
  type DeleteUserDataResult,
} from "./privacy.js";
export type { ClaudeClient } from "./claude.js";

export type BrainDeps = {
  store: Store;
  apiKey?: string;
  claude?: ClaudeClient;
  calendar?: CalendarClient;
  notifyHuman: (numeroHumano: string, resumo: string) => Promise<void>;
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

  const calendar = deps.calendar ?? createGoogleCalendarClient();

  const agent = createAgent({
    store: deps.store,
    claude,
    calendar,
    notifyHuman: deps.notifyHuman,
    model: deps.model,
    getConfig: deps.getConfig,
    now: deps.now,
  });

  return {
    name: "brain" as const,
    ready: true,
    agent,
    calendar,
    handleText: (waId: string, text: string) =>
      agent.handleUserMessage(waId, text),
  };
}
