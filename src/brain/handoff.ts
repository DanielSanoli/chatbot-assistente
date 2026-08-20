import { DateTime } from "luxon";
import type { ClientConfig } from "../config/schema.js";
import { isWorkingDay, parseHhMm, weekdayToDayName, normalizeDayName } from "../calendar/days.js";
import { logEvent, type Store } from "../store/index.js";
import { insertDemanda } from "../store/demandas.js";
import {
  ensureConversation,
  getConversation,
  setConversationState,
  type EstadoPayload,
} from "../store/conversations.js";
import { maskPhone } from "../channel/mask.js";
import { normalizeTerm } from "./normalize.js";

export const URGENCY_PATTERNS: RegExp[] = [
  /\bmuita dor\b/i,
  /\bdor (forte|intensa|insuportavel|insuportável)\b/i,
  /\bestou com (muita )?dor\b/i,
  /\bsangramento\b/i,
  /\bsangrando\b/i,
  /\binchaco\b/i,
  /\binchaço\b/i,
  /\binchado\b/i,
  /\burgencia\b/i,
  /\burgência\b/i,
  /\bemergenza\b/i,
];

export type HandoffTransferInput = {
  store: Store;
  config: ClientConfig;
  waId: string;
  motivo: string;
  intencao?: string;
  userText?: string;
  agora?: DateTime;
  /** Envia o resumo ao número humano (WhatsApp). */
  notifyHuman: (numeroHumano: string, resumo: string) => Promise<void>;
};

export type HandoffTransferResult = {
  clientMessage: string;
  humanSummary: string;
  numeroHumano: string;
  motivo: string;
  estado: "EM_HUMANO";
};

function nowTz(config: ClientConfig, agora?: DateTime): DateTime {
  const tz = config.cliente.timezone;
  return (agora ?? DateTime.now().setZone(tz)).setZone(tz);
}

function dayHoursFor(
  config: ClientConfig,
  day: DateTime,
): { inicio: DateTime; fim: DateTime } | null {
  if (!isWorkingDay(config.funcionamento.dias, day)) return null;
  const dayName = normalizeDayName(weekdayToDayName(day.weekday));
  const special =
    config.funcionamento.por_dia[dayName] ??
    Object.entries(config.funcionamento.por_dia).find(
      ([key]) => normalizeDayName(key) === dayName,
    )?.[1];
  const horario = special ?? config.funcionamento.horario;
  const startParts = parseHhMm(horario.inicio);
  const endParts = parseHhMm(horario.fim);
  return {
    inicio: day.set({
      hour: startParts.hour,
      minute: startParts.minute,
      second: 0,
      millisecond: 0,
    }),
    fim: day.set({
      hour: endParts.hour,
      minute: endParts.minute,
      second: 0,
      millisecond: 0,
    }),
  };
}

export function isWithinBusinessHours(
  config: ClientConfig,
  agora?: DateTime,
): boolean {
  const now = nowTz(config, agora);
  const hours = dayHoursFor(config, now);
  if (!hours) return false;
  return now >= hours.inicio && now < hours.fim;
}

export function clientHandoffMessage(
  config: ClientConfig,
  agora?: DateTime,
): string {
  return isWithinBusinessHours(config, agora)
    ? config.handoff.mensagem
    : config.handoff.fora_do_horario;
}

export function detectUrgency(text: string): boolean {
  const normalized = normalizeTerm(text);
  return URGENCY_PATTERNS.some((re) => re.test(text) || re.test(normalized));
}

export function detectExplicitHandoff(
  text: string,
  gatilhosExplicitos: string[],
): string | null {
  const normalized = normalizeTerm(text);
  for (const gatilho of gatilhosExplicitos) {
    const g = normalizeTerm(gatilho);
    if (g && normalized.includes(g)) {
      return gatilho;
    }
  }
  return null;
}

export function matchTemaSempreHumano(
  temaOuMotivo: string,
  temas: string[],
): string | null {
  const needle = normalizeTerm(temaOuMotivo);
  for (const tema of temas) {
    if (normalizeTerm(tema) === needle || needle.includes(normalizeTerm(tema))) {
      return tema;
    }
  }
  return null;
}

/**
 * Conversa EM_HUMANO fica muda por silencio_em_humano_horas (default 12h).
 * Retorna true se o bot NÃO deve responder.
 */
export function isMutedEmHumano(
  store: Store,
  waId: string,
  config: ClientConfig,
  agora?: DateTime,
): boolean {
  const conv = getConversation(store, waId);
  if (!conv || conv.estado !== "EM_HUMANO") return false;

  const sinceRaw = conv.estado_payload.emHumanoDesde;
  if (!sinceRaw) return true;

  const since = DateTime.fromISO(sinceRaw, { zone: config.cliente.timezone });
  if (!since.isValid) return true;

  const hours = nowTz(config, agora).diff(since, "hours").hours;
  return hours < config.handoff.silencio_em_humano_horas;
}

export function buildHumanSummary(input: {
  waId: string;
  nome?: string;
  intencao?: string;
  userText?: string;
  motivo: string;
}): string {
  const nome = input.nome?.trim() || "não informado";
  const queria =
    input.intencao?.trim() ||
    input.userText?.trim() ||
    "não ficou claro no histórico curto";

  return [
    "🔁 Transferência do chatbot",
    `Telefone: ${input.waId}`,
    `Nome: ${nome}`,
    `O que o cliente queria: ${queria}`,
    `Motivo da transferência: ${input.motivo}`,
  ].join("\n");
}

export async function transferToHuman(
  input: HandoffTransferInput,
): Promise<HandoffTransferResult> {
  const agora = nowTz(input.config, input.agora);
  const conv = ensureConversation(input.store, input.waId);
  const payload: EstadoPayload = {
    ...conv.estado_payload,
    motivoHandoff: input.motivo,
    intencao: input.intencao ?? conv.estado_payload.intencao ?? input.userText,
    emHumanoDesde: agora.toISO() ?? agora.toString(),
    slots: undefined,
    propostoEm: undefined,
  };

  setConversationState(input.store, input.waId, "EM_HUMANO", payload);

  const clientMessage = clientHandoffMessage(input.config, agora);
  const humanSummary = buildHumanSummary({
    waId: input.waId,
    nome: payload.nomeCompleto,
    intencao: payload.intencao,
    userText: input.userText,
    motivo: input.motivo,
  });

  await input.notifyHuman(input.config.handoff.numero_humano, humanSummary);

  logEvent(input.store, "handoff.transferido", {
    wa_id_masked: maskPhone(input.waId),
    motivo: input.motivo,
    intencao: payload.intencao ?? null,
    user_text: input.userText ?? null,
    numero_humano_masked: maskPhone(input.config.handoff.numero_humano),
    dentro_horario: isWithinBusinessHours(input.config, agora),
  });

  return {
    clientMessage,
    humanSummary,
    numeroHumano: input.config.handoff.numero_humano,
    motivo: input.motivo,
    estado: "EM_HUMANO",
  };
}

/**
 * Registra falha de entendimento. Na 2ª falha seguida no mesmo assunto, retorna
 * que deve transferir.
 */
export function registerUnderstandingFailure(
  store: Store,
  waId: string,
  assunto: string,
): { count: number; deveTransferir: boolean; assunto: string } {
  const conv = ensureConversation(store, waId);
  const normalized = normalizeTerm(assunto) || "geral";
  const prev = conv.estado_payload.falhasEntendimento;
  const count =
    prev && prev.assunto === normalized ? prev.count + 1 : 1;

  setConversationState(store, waId, conv.estado === "EM_HUMANO" ? "EM_HUMANO" : conv.estado, {
    ...conv.estado_payload,
    falhasEntendimento: { assunto: normalized, count },
  });

  logEvent(store, "handoff.falha_entendimento", {
    wa_id_masked: maskPhone(waId),
    assunto: normalized,
    count,
  });

  return {
    count,
    deveTransferir: count >= 2,
    assunto: normalized,
  };
}

/**
 * Registra quem pediu horário que não existia.
 *
 * O telefone completo vai para a tabela `demandas` — é lista de retorno
 * comercial, tem finalidade declarada e entra no expurgo. O evento fica só
 * com o telefone mascarado, para o relatório e a linha do tempo: log de
 * auditoria não é lugar de guardar dado de contato.
 */
export function recordDemandaNaoAtendida(input: {
  store: Store;
  waId: string;
  servicoId: string;
  janelaDesejada?: string;
  agora?: DateTime;
  timezone: string;
}): void {
  const ts = (input.agora ?? DateTime.now().setZone(input.timezone))
    .setZone(input.timezone)
    .toISO();

  const demanda = insertDemanda(input.store, {
    waId: input.waId,
    servicoId: input.servicoId,
    janelaDesejada: input.janelaDesejada,
  });

  logEvent(input.store, "demanda_nao_atendida", {
    wa_id_masked: maskPhone(input.waId),
    demanda_id: demanda.id,
    servicoId: input.servicoId,
    janela_desejada: input.janelaDesejada ?? null,
    timestamp: ts,
  });
}
