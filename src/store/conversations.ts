import type { Store } from "./db.js";

export const CONVERSATION_STATES = [
  "LIVRE",
  "COLETANDO",
  "PROPOSTO",
  "CONFIRMADO",
  "HANDOFF",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

export type ProposedSlot = {
  indice: number;
  inicio: string;
  fim: string;
  profissionalId: string;
  profissionalNome: string;
  calendarioId: string;
  servicoId: string;
};

export type EstadoPayload = {
  servicoId?: string;
  nomeCompleto?: string;
  propostoEm?: string;
  slots?: ProposedSlot[];
  eventId?: string;
  preferencia?: string;
};

export type ConversationRow = {
  id: number;
  wa_id: string;
  estado: ConversationState;
  estado_payload: EstadoPayload;
  atualizado_em: string;
};

function parsePayload(raw: string | null | undefined): EstadoPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as EstadoPayload;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function normalizeEstado(value: string): ConversationState {
  if ((CONVERSATION_STATES as readonly string[]).includes(value)) {
    return value as ConversationState;
  }
  return "LIVRE";
}

export function getConversation(
  store: Store,
  waId: string,
): ConversationRow | null {
  const row = store.db
    .prepare(
      `SELECT id, wa_id, estado, estado_payload, atualizado_em
       FROM conversations WHERE wa_id = ?`,
    )
    .get(waId) as
    | {
        id: number;
        wa_id: string;
        estado: string;
        estado_payload: string;
        atualizado_em: string;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    wa_id: row.wa_id,
    estado: normalizeEstado(row.estado),
    estado_payload: parsePayload(row.estado_payload),
    atualizado_em: row.atualizado_em,
  };
}

export function ensureConversation(store: Store, waId: string): ConversationRow {
  store.db
    .prepare(
      `INSERT INTO conversations (wa_id, estado, estado_payload, atualizado_em)
       VALUES (?, 'LIVRE', '{}', datetime('now'))
       ON CONFLICT(wa_id) DO UPDATE SET atualizado_em = atualizado_em`,
    )
    .run(waId);

  const row = getConversation(store, waId);
  if (!row) {
    throw new Error(`Falha ao criar conversa para ${waId}`);
  }
  return row;
}

export function setConversationState(
  store: Store,
  waId: string,
  estado: ConversationState,
  payload: EstadoPayload = {},
): ConversationRow {
  ensureConversation(store, waId);
  store.db
    .prepare(
      `UPDATE conversations
       SET estado = ?, estado_payload = ?, atualizado_em = datetime('now')
       WHERE wa_id = ?`,
    )
    .run(estado, JSON.stringify(payload), waId);

  const row = getConversation(store, waId);
  if (!row) {
    throw new Error(`Falha ao atualizar conversa ${waId}`);
  }
  return row;
}

export function patchConversationPayload(
  store: Store,
  waId: string,
  patch: Partial<EstadoPayload>,
  estado?: ConversationState,
): ConversationRow {
  const current = ensureConversation(store, waId);
  const nextPayload = { ...current.estado_payload, ...patch };
  return setConversationState(
    store,
    waId,
    estado ?? current.estado,
    nextPayload,
  );
}
