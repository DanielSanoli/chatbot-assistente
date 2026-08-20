import { DateTime } from "luxon";
import { maskPhone } from "../channel/mask.js";
import type { Store } from "../store/index.js";
import { maskPhoneReport } from "./mask.js";
import {
  distinctConversations,
  loadEventsBetween,
  loadMessagesBetween,
  weekRange,
  type DbEvent,
  type DbMessage,
} from "./queries.js";

const DESCONHECIMENTO_MOTIVOS = [
  "servico_inexistente",
  "falha_entendimento",
  "erro_interno:resposta_vazia",
];

export type WeeklyReportData = {
  periodo: { inicio: string; fim: string };
  conversasAtendidas: number;
  agendamentosConcluidos: number;
  remarcacoesConcluidas: number;
  cancelamentosAutonomos: number;
  /** Minutos de agenda devolvidos por cancelamento — vaga que dá para revender. */
  minutosLiberados: number;
  /** Pedidos recusados pela política de antecedência (foram para a recepção). */
  cancelamentosEmCimaDaHora: number;
  /** Evento antigo que ficou na agenda após remarcação: exige limpeza manual. */
  eventosOrfaos: Array<{ inicio: string; eventId: string }>;
  conversasComHandoff: number;
  conversasContidas: number;
  taxaContencao: number;
  tempoMedioPrimeiraRespostaSeg: number | null;
  handoffMotivos: Array<{ motivo: string; count: number }>;
  demandaPorServico: Array<{ servicoId: string; count: number }>;
  perguntasDesconhecimento: Array<{
    telefoneMascarado: string;
    pergunta: string;
    motivo: string;
  }>;
  respostaSemFonte: Array<{
    telefoneMascarado: string;
    pergunta: string;
    criadoEm: string;
  }>;
};

function isDesconhecimento(motivo: string): boolean {
  const m = motivo.toLowerCase();
  return DESCONHECIMENTO_MOTIVOS.some((d) => m.includes(d.toLowerCase()));
}

function firstResponseSeconds(messages: DbMessage[]): number | null {
  const firstIn = messages.find((m) => m.direcao === "in");
  if (!firstIn) return null;
  const firstOut = messages.find(
    (m) => m.direcao === "out" && m.id > firstIn.id,
  );
  if (!firstOut) return null;
  const a = DateTime.fromISO(firstIn.timestamp, { setZone: true });
  const b = DateTime.fromISO(firstOut.timestamp, { setZone: true });
  if (!a.isValid || !b.isValid) return null;
  const sec = b.diff(a, "seconds").seconds;
  return sec >= 0 ? sec : null;
}

function toLast4FromAnyMask(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return maskPhoneReport(digits);
  if (value.includes("****")) {
    return `****${value.slice(-4)}`;
  }
  return maskPhoneReport(value);
}

export function computeWeeklyReport(
  store: Store,
  reference: DateTime,
): WeeklyReportData {
  const { inicio, fim } = weekRange(reference);
  const messages = loadMessagesBetween(store, inicio, fim);
  const events = loadEventsBetween(store, inicio, fim);
  const conversas = distinctConversations(messages);

  const handoffEvents = events.filter((e) => e.tipo === "handoff.transferido");
  const handoffWa = new Set(
    handoffEvents.map((e) => String(e.payload.wa_id_masked ?? "")),
  );

  const conversasComHandoff = conversas.filter((c) =>
    handoffWa.has(maskPhone(c.wa_id)),
  ).length;

  const conversasAtendidas = conversas.length;
  const conversasContidas = Math.max(0, conversasAtendidas - conversasComHandoff);
  const taxaContencao =
    conversasAtendidas === 0 ? 0 : conversasContidas / conversasAtendidas;

  const agendamentosConcluidos = events.filter(
    (e) => e.tipo === "booking.confirmado",
  ).length;

  const remarcacoesConcluidas = events.filter(
    (e) => e.tipo === "booking.remarcado",
  ).length;

  const cancelados = events.filter((e) => e.tipo === "booking.cancelado");
  const cancelamentosAutonomos = cancelados.length;
  const minutosLiberados = cancelados.reduce(
    (total, e) => total + Number(e.payload.duracao_min ?? 0),
    0,
  );

  const cancelamentosEmCimaDaHora = events.filter(
    (e) => e.tipo === "booking.cancelamento_tardio",
  ).length;

  const eventosOrfaos = events
    .filter((e) => e.tipo === "booking.remarcacao_evento_orfao")
    .map((e) => ({
      inicio: String(e.payload.inicio_antigo ?? "(sem data)"),
      eventId: String(e.payload.event_id_antigo ?? "(sem id)"),
    }));

  const motivoCount = new Map<string, number>();
  for (const e of handoffEvents) {
    const motivo = String(e.payload.motivo ?? "desconhecido");
    motivoCount.set(motivo, (motivoCount.get(motivo) ?? 0) + 1);
  }
  const handoffMotivos = [...motivoCount.entries()]
    .map(([motivo, count]) => ({ motivo, count }))
    .sort((a, b) => b.count - a.count);

  const demandaCount = new Map<string, number>();
  for (const e of events.filter((x) => x.tipo === "demanda_nao_atendida")) {
    const servicoId = String(e.payload.servicoId ?? "desconhecido");
    demandaCount.set(servicoId, (demandaCount.get(servicoId) ?? 0) + 1);
  }
  const demandaPorServico = [...demandaCount.entries()]
    .map(([servicoId, count]) => ({ servicoId, count }))
    .sort((a, b) => b.count - a.count);

  const perguntasDesconhecimento = handoffEvents
    .filter((e) => isDesconhecimento(String(e.payload.motivo ?? "")))
    .map((e) => ({
      telefoneMascarado: toLast4FromAnyMask(
        String(e.payload.wa_id_masked ?? "****"),
      ),
      pergunta: String(
        e.payload.user_text ?? e.payload.intencao ?? "(sem texto)",
      ),
      motivo: String(e.payload.motivo ?? ""),
    }));

  const respostaSemFonte = events
    .filter((e) => e.tipo === "resposta_sem_fonte")
    .map((e) => ({
      telefoneMascarado: toLast4FromAnyMask(
        String(e.payload.wa_id_masked ?? "****"),
      ),
      pergunta: String(e.payload.user_text ?? "(sem texto)"),
      criadoEm: e.criado_em,
    }));

  const firstResponses: number[] = [];
  for (const conv of conversas) {
    const msgs = messages.filter((m) => m.wa_id === conv.wa_id);
    const sec = firstResponseSeconds(msgs);
    if (sec !== null) firstResponses.push(sec);
  }
  const tempoMedioPrimeiraRespostaSeg =
    firstResponses.length === 0
      ? null
      : firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length;

  return {
    periodo: {
      inicio: inicio.toISODate() ?? inicio.toFormat("yyyy-LL-dd"),
      fim: fim.toISODate() ?? fim.toFormat("yyyy-LL-dd"),
    },
    conversasAtendidas,
    agendamentosConcluidos,
    remarcacoesConcluidas,
    cancelamentosAutonomos,
    minutosLiberados,
    cancelamentosEmCimaDaHora,
    eventosOrfaos,
    conversasComHandoff,
    conversasContidas,
    taxaContencao,
    tempoMedioPrimeiraRespostaSeg,
    handoffMotivos,
    demandaPorServico,
    perguntasDesconhecimento,
    respostaSemFonte,
  };
}

export function formatWeeklyReportText(data: WeeklyReportData): string {
  const lines: string[] = [];
  const pct = (data.taxaContencao * 100).toFixed(1);

  lines.push(`# Relatório semanal ${data.periodo.inicio} → ${data.periodo.fim}`);
  lines.push("");

  lines.push("## ⚠ ALERTA DE RISCO — resposta_sem_fonte");
  if (data.respostaSemFonte.length === 0) {
    lines.push("Nenhum incidente no período.");
  } else {
    lines.push(
      `**${data.respostaSemFonte.length} incidente(s)** — qualquer ocorrência é crítica.`,
    );
    for (const item of data.respostaSemFonte) {
      lines.push(
        `- ${item.telefoneMascarado} | ${item.criadoEm} | pergunta: ${item.pergunta}`,
      );
    }
  }
  lines.push("");

  if (data.eventosOrfaos.length > 0) {
    lines.push("## ⚠ Eventos a limpar na agenda");
    lines.push(
      "Remarcação concluída, mas o evento antigo não saiu do Google Calendar. Apague à mão para liberar o horário:",
    );
    for (const item of data.eventosOrfaos) {
      lines.push(`- ${item.inicio} (evento ${item.eventId})`);
    }
    lines.push("");
  }

  lines.push("## Resumo");
  lines.push(`- Conversas atendidas: **${data.conversasAtendidas}**`);
  lines.push(`- Agendamentos concluídos: **${data.agendamentosConcluidos}**`);
  lines.push(`- Remarcações resolvidas pelo bot: **${data.remarcacoesConcluidas}**`);
  lines.push(
    `- Cancelamentos resolvidos pelo bot: **${data.cancelamentosAutonomos}** (${(
      data.minutosLiberados / 60
    ).toFixed(1)}h de agenda devolvidas para revenda)`,
  );
  lines.push(
    `- Pedidos em cima da hora enviados à recepção: **${data.cancelamentosEmCimaDaHora}**`,
  );
  lines.push(
    `- Contenção (sem handoff): **${data.conversasContidas}/${data.conversasAtendidas} (${pct}%)**`,
  );
  lines.push(
    `- Tempo médio 1ª resposta: **${
      data.tempoMedioPrimeiraRespostaSeg === null
        ? "n/a"
        : `${data.tempoMedioPrimeiraRespostaSeg.toFixed(1)}s`
    }**`,
  );
  lines.push("");

  lines.push("## Motivos de handoff (ranqueados)");
  if (data.handoffMotivos.length === 0) {
    lines.push("(nenhum handoff)");
  } else {
    for (const row of data.handoffMotivos) {
      lines.push(`- ${row.motivo}: ${row.count}`);
    }
  }
  lines.push("");

  lines.push("## demanda_nao_atendida por serviço");
  if (data.demandaPorServico.length === 0) {
    lines.push("(nenhuma)");
  } else {
    for (const row of data.demandaPorServico) {
      lines.push(`- ${row.servicoId}: ${row.count}`);
    }
  }
  lines.push("");

  lines.push("## Perguntas com handoff por desconhecimento");
  if (data.perguntasDesconhecimento.length === 0) {
    lines.push("(nenhuma)");
  } else {
    for (const row of data.perguntasDesconhecimento) {
      lines.push(
        `- ${row.telefoneMascarado} | ${row.motivo} | ${row.pergunta}`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function conversationHadHandoff(
  waId: string,
  handoffEvents: DbEvent[],
): boolean {
  const masked = maskPhone(waId);
  return handoffEvents.some((e) => e.payload.wa_id_masked === masked);
}
