export {
  openStore,
  logEvent,
  purgeEventsBefore,
  countEventsSince,
  type Store,
} from "./db.js";
export {
  upsertConversation,
  findConversationId,
  tryInsertMessage,
  countMessagesByWaMessageId,
  type MessageDirection,
} from "./messages.js";
export {
  insertDemanda,
  listDemandasAbertas,
  marcarDemandaContatada,
  deleteDemandasByWaId,
  purgeDemandasBefore,
  DEMANDA_STATUSES,
  type Demanda,
  type DemandaStatus,
} from "./demandas.js";
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
export {
  insertAppointment,
  getAppointment,
  listActiveAppointments,
  markAppointmentCancelled,
  markAppointmentRescheduled,
  deletePastAppointments,
  purgeAppointmentsBefore,
  SlotCollisionError,
  APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentStatus,
  type NewAppointment,
} from "./appointments.js";
