import { DateTime } from "luxon";
import type { Store } from "../store/index.js";
import {
  dayBounds,
  eventsForWaId,
  loadEventsBetween,
  loadMessagesBetween,
  type DbEvent,
  type DbMessage,
} from "./queries.js";

function fmtTs(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  if (!dt.isValid) {
    const fallback = DateTime.fromSQL(iso, { zone: "utc" }).setZone(zone);
    return fallback.isValid ? fallback.toFormat("HH:mm:ss") : iso;
  }
  return dt.toFormat("HH:mm:ss");
}

function describeTurnEvent(event: DbEvent): string[] {
  const lines: string[] = [];
  if (event.tipo === "brain.turno") {
    const ferramentas = Array.isArray(event.payload.ferramentas)
      ? (event.payload.ferramentas as string[]).join(", ")
      : "—";
    const handoff = event.payload.handoff === true ? "sim" : "não";
    const semFonte =
      event.payload.resposta_sem_fonte === true ? " ⚠ RESPOSTA_SEM_FONTE" : "";
    lines.push(
      `  ▸ turno | ferramentas: [${ferramentas}] | handoff: ${handoff}${semFonte}`,
    );
  } else if (event.tipo === "handoff.transferido") {
    lines.push(
      `  ▸ HANDOFF | motivo: ${String(event.payload.motivo ?? "—")}`,
    );
    if (event.payload.intencao) {
      lines.push(`    intenção: ${String(event.payload.intencao)}`);
    }
  } else if (event.tipo === "booking.confirmado") {
    lines.push(
      `  ▸ AGENDADO | início: ${String(event.payload.inicio ?? "—")} | duração: ${String(event.payload.duracao_min ?? "—")}min`,
    );
  } else if (event.tipo === "booking.proposto") {
    lines.push(
      `  ▸ proposta de horários | serviço: ${String(event.payload.servicoId ?? "—")}`,
    );
  } else if (event.tipo === "resposta_sem_fonte") {
    lines.push(`  ▸ ⚠ INCIDENTE resposta_sem_fonte`);
    if (event.payload.user_text) {
      lines.push(`    pergunta: ${String(event.payload.user_text)}`);
    }
  } else if (event.tipo === "demanda_nao_atendida") {
    lines.push(
      `  ▸ demanda_nao_atendida | serviço: ${String(event.payload.servicoId ?? "—")} | janela: ${String(event.payload.janela_desejada ?? "—")}`,
    );
  } else if (
    event.tipo.startsWith("booking.") ||
    event.tipo.startsWith("handoff.")
  ) {
    lines.push(`  ▸ ${event.tipo}`);
  }
  return lines;
}

function attachEventsToMessages(
  messages: DbMessage[],
  events: DbEvent[],
): Array<{ kind: "msg"; msg: DbMessage } | { kind: "event"; event: DbEvent }> {
  const timeline: Array<
    | { kind: "msg"; msg: DbMessage; t: number }
    | { kind: "event"; event: DbEvent; t: number }
  > = [];

  for (const msg of messages) {
    const t = DateTime.fromISO(msg.timestamp, { setZone: true }).toMillis();
    timeline.push({ kind: "msg", msg, t: Number.isFinite(t) ? t : 0 });
  }
  for (const event of events) {
    const t = DateTime.fromISO(event.criado_em, { setZone: true }).toMillis();
    timeline.push({ kind: "event", event, t: Number.isFinite(t) ? t : 0 });
  }

  timeline.sort((a, b) => a.t - b.t || (a.kind === "msg" ? -1 : 1));
  return timeline.map((item) =>
    item.kind === "msg"
      ? { kind: "msg" as const, msg: item.msg }
      : { kind: "event" as const, event: item.event },
  );
}

export function buildDayTranscript(
  store: Store,
  dayIso: string,
  zone = "America/Sao_Paulo",
): string {
  const { inicio, fim } = dayBounds(dayIso, zone);
  const messages = loadMessagesBetween(store, inicio, fim);
  const events = loadEventsBetween(store, inicio, fim);

  const byWa = new Map<string, DbMessage[]>();
  for (const msg of messages) {
    const list = byWa.get(msg.wa_id) ?? [];
    list.push(msg);
    byWa.set(msg.wa_id, list);
  }

  const lines: string[] = [
    `════════════════════════════════════════════════════════════`,
    `Transcrições — ${dayIso} (${zone})`,
    `Conversas com atividade: ${byWa.size}`,
    `════════════════════════════════════════════════════════════`,
    "",
  ];

  if (byWa.size === 0) {
    lines.push("(nenhuma mensagem neste dia)");
    lines.push("");
    return lines.join("\n");
  }

  for (const [waId, msgs] of byWa) {
    const estado = msgs[msgs.length - 1]?.estado ?? "—";
    const convEvents = eventsForWaId(events, waId);
    lines.push(`── Conversa ${waId} | estado atual: ${estado} ──`);

    const timeline = attachEventsToMessages(msgs, convEvents);
    for (const item of timeline) {
      if (item.kind === "msg") {
        const who = item.msg.direcao === "in" ? "CLIENTE" : "BOT   ";
        lines.push(
          `[${fmtTs(item.msg.timestamp, zone)}] ${who}: ${item.msg.texto}`,
        );
      } else {
        lines.push(...describeTurnEvent(item.event));
      }
    }

    const handoff = convEvents.find((e) => e.tipo === "handoff.transferido");
    if (handoff) {
      lines.push(
        `>> Motivo final de handoff: ${String(handoff.payload.motivo ?? "—")}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
