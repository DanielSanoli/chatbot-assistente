import type { Store } from "./db.js";

export type HistoryMessage = {
  id: number;
  direcao: "in" | "out";
  texto: string;
  timestamp: string;
};

const IDLE_HOURS = 6;
const WINDOW_SIZE = 20;

function hoursBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60);
}

function getConversationId(store: Store, waId: string): number | null {
  const row = store.db
    .prepare(`SELECT id FROM conversations WHERE wa_id = ?`)
    .get(waId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function clearConversationMessages(
  store: Store,
  conversationId: number,
): void {
  store.db
    .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
    .run(conversationId);
}

/**
 * Janela das últimas 20 mensagens. Se a conversa ficou 6h sem atividade,
 * apaga o histórico e começa do zero (retorna só o que restar — tipicamente vazio
 * antes da mensagem atual, ou só a mensagem atual se já tiver sido gravada).
 */
export function getConversationWindow(
  store: Store,
  waId: string,
  options?: { now?: Date; limit?: number; idleHours?: number },
): HistoryMessage[] {
  const conversationId = getConversationId(store, waId);
  if (conversationId === null) return [];

  const limit = options?.limit ?? WINDOW_SIZE;
  const idleHours = options?.idleHours ?? IDLE_HOURS;
  const now = options?.now ?? new Date();

  const last = store.db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE conversation_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(conversationId) as { timestamp: string } | undefined;

  if (last) {
    // Se há mais de uma mensagem e a penúltima (atividade anterior) + gap...
    // Regra: se a ÚLTIMA atividade antes da mensagem atual for > 6h.
    // Como a mensagem atual já pode estar gravada, olhamos a penúltima.
    const previous = store.db
      .prepare(
        `SELECT timestamp FROM messages
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT 1 OFFSET 1`,
      )
      .get(conversationId) as { timestamp: string } | undefined;

    const anchor = previous?.timestamp ?? last.timestamp;
    // Se só existe a mensagem atual, não há idle anterior — mantém.
    if (previous && hoursBetween(anchor, now.toISOString()) >= idleHours) {
      // Mantém só a mensagem mais recente (contato atual) e limpa o resto.
      const latestId = (
        store.db
          .prepare(
            `SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(conversationId) as { id: number }
      ).id;
      store.db
        .prepare(
          `DELETE FROM messages WHERE conversation_id = ? AND id != ?`,
        )
        .run(conversationId, latestId);
    } else if (
      !previous &&
      hoursBetween(last.timestamp, now.toISOString()) >= idleHours
    ) {
      // Caso degenerado: uma mensagem antiga reaberta — limpa e recomeça.
      clearConversationMessages(store, conversationId);
      return [];
    }
  }

  const rows = store.db
    .prepare(
      `SELECT id, direcao, texto, timestamp FROM messages
       WHERE conversation_id = ?
         AND texto NOT LIKE '[unsupported:%'
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(conversationId, limit) as HistoryMessage[];

  return rows.reverse();
}
