import { DateTime } from "luxon";
import { maskPhone } from "../channel/mask.js";
import type { Store } from "../store/index.js";

export type DbMessage = {
  id: number;
  conversation_id: number;
  wa_id: string;
  estado: string;
  direcao: "in" | "out";
  texto: string;
  timestamp: string;
};

export type DbEvent = {
  id: number;
  tipo: string;
  payload: Record<string, unknown>;
  criado_em: string;
};

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function weekRange(
  reference: DateTime,
): { inicio: DateTime; fim: DateTime } {
  // Sempre segunda→domingo (ISO), independente do locale.
  const day = reference.setZone(reference.zoneName ?? "utc");
  const inicio = day.startOf("day").minus({ days: day.weekday - 1 });
  const fim = inicio.plus({ days: 6 }).endOf("day");
  return { inicio, fim };
}

export function dayBounds(
  dayIso: string,
  zone: string,
): { inicio: DateTime; fim: DateTime } {
  const day = DateTime.fromISO(dayIso, { zone });
  if (!day.isValid) {
    throw new Error(`Data inválida: ${dayIso} (use YYYY-MM-DD)`);
  }
  return { inicio: day.startOf("day"), fim: day.endOf("day") };
}

export function loadMessagesBetween(
  store: Store,
  inicio: DateTime,
  fim: DateTime,
): DbMessage[] {
  const rows = store.db
    .prepare(
      `SELECT m.id, m.conversation_id, c.wa_id, c.estado, m.direcao, m.texto, m.timestamp
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.timestamp >= ? AND m.timestamp <= ?
         AND m.texto NOT LIKE '[unsupported:%'
       ORDER BY c.wa_id ASC, m.id ASC`,
    )
    .all(inicio.toUTC().toISO(), fim.toUTC().toISO()) as Array<{
    id: number;
    conversation_id: number;
    wa_id: string;
    estado: string;
    direcao: "in" | "out";
    texto: string;
    timestamp: string;
  }>;

  return rows;
}

export function loadEventsBetween(
  store: Store,
  inicio: DateTime,
  fim: DateTime,
): DbEvent[] {
  const rows = store.db
    .prepare(
      `SELECT id, tipo, payload_json, criado_em
       FROM events
       WHERE criado_em >= ? AND criado_em <= ?
       ORDER BY id ASC`,
    )
    .all(inicio.toUTC().toISO(), fim.toUTC().toISO()) as Array<{
    id: number;
    tipo: string;
    payload_json: string;
    criado_em: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    tipo: r.tipo,
    payload: parsePayload(r.payload_json),
    criado_em: r.criado_em,
  }));
}

export function eventsForWaId(
  events: DbEvent[],
  waId: string,
): DbEvent[] {
  const masked = maskPhone(waId);
  return events.filter((e) => e.payload.wa_id_masked === masked);
}

export function distinctConversations(
  messages: DbMessage[],
): Array<{ wa_id: string; estado: string; conversation_id: number }> {
  const map = new Map<string, { wa_id: string; estado: string; conversation_id: number }>();
  for (const m of messages) {
    if (!map.has(m.wa_id)) {
      map.set(m.wa_id, {
        wa_id: m.wa_id,
        estado: m.estado,
        conversation_id: m.conversation_id,
      });
    }
  }
  return [...map.values()];
}
