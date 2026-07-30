export { openStore, logEvent, type Store } from "./db.js";
export {
  upsertConversation,
  tryInsertMessage,
  countMessagesByWaMessageId,
  type MessageDirection,
} from "./messages.js";
export {
  getConversationWindow,
  clearConversationMessages,
  type HistoryMessage,
} from "./history.js";
export {
  ensureConversation,
  getConversation,
  setConversationState,
  patchConversationPayload,
  precisaEnviarAvisoLgpd,
  marcarAvisoLgpdEnviado,
  CONVERSATION_STATES,
  type ConversationState,
  type ConversationRow,
  type EstadoPayload,
  type ProposedSlot,
} from "./conversations.js";
