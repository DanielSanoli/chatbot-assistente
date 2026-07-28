import type { Store } from "./db.js";

export type MessageDirection = "in" | "out";

export function upsertConversation(store: Store, waId: string): number {
  store.db
    .prepare(
      `INSERT INTO conversations (wa_id, estado, atualizado_em)
       VALUES (?, 'novo', datetime('now'))
       ON CONFLICT(wa_id) DO UPDATE SET atualizado_em = datetime('now')`,
    )
    .run(waId);

  const row = store.db
    .prepare(`SELECT id FROM conversations WHERE wa_id = ?`)
    .get(waId) as { id: number };

  return row.id;
}

/**
 * Insere mensagem. Retorna false se wa_message_id já existir (idempotência).
 */
export function tryInsertMessage(
  store: Store,
  input: {
    conversationId: number;
    direcao: MessageDirection;
    texto: string;
    waMessageId: string | null;
    timestamp?: string;
  },
): boolean {
  try {
    store.db
      .prepare(
        `INSERT INTO messages (conversation_id, direcao, texto, timestamp, wa_message_id)
         VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)`,
      )
      .run(
        input.conversationId,
        input.direcao,
        input.texto,
        input.timestamp ?? null,
        input.waMessageId,
      );
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      return false;
    }
    throw err;
  }
}

export function countMessagesByWaMessageId(
  store: Store,
  waMessageId: string,
): number {
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE wa_message_id = ?`)
    .get(waMessageId) as { n: number };
  return row.n;
}
