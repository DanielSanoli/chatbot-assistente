import { DateTime, Interval } from "luxon";
import type { CalendarClient } from "../calendar/google.js";
import { buscarHorarios } from "../calendar/slots.js";
import type { ClientConfig } from "../config/schema.js";
import { logEvent, type Store } from "../store/index.js";
import {
  ensureConversation,
  getConversation,
  setConversationState,
  type ProposedSlot,
} from "../store/conversations.js";
import { maskPhone } from "../channel/mask.js";
import { recordDemandaNaoAtendida } from "./handoff.js";
import { normalizeTerm } from "./normalize.js";

export const PROPOSTO_TTL_MINUTES = 30;
export const RECHECK_AFTER_MINUTES = 15;

const WEEKDAY_PT: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

const AMBIGUOUS_SLOT_RE =
  /^(pode ser|pode|qualquer( um)?|qualquer horario|tanto faz|o que (preferir|quiser)|tanto faz pra mim|tanto faz para mim|qualquer um serve|um qualquer)$/i;

export type BookingContext = {
  store: Store;
  config: ClientConfig;
  calendar: CalendarClient;
  waId: string;
  agora?: DateTime;
  userText?: string;
};

function nowTz(ctx: BookingContext): DateTime {
  const tz = ctx.config.cliente.timezone;
  return (ctx.agora ?? DateTime.now().setZone(tz)).setZone(tz);
}

export function isAmbiguousSlotChoice(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = normalizeTerm(trimmed).replace(/\s+/g, " ");
  return AMBIGUOUS_SLOT_RE.test(normalized);
}

export function isFullName(nome: string): boolean {
  const parts = nome
    .trim()
    .split(/\s+/)
    .filter((p) => p.length >= 2);
  return parts.length >= 2;
}

export function expirePropostoIfNeeded(ctx: BookingContext): boolean {
  const conv = ensureConversation(ctx.store, ctx.waId);
  const hasProposal =
    (conv.estado === "PROPOSTO" || conv.estado === "COLETANDO") &&
    (conv.estado_payload.slots?.length ?? 0) > 0;

  if (!hasProposal) return false;

  const propostoEm = conv.estado_payload.propostoEm;
  if (!propostoEm) {
    setConversationState(ctx.store, ctx.waId, "LIVRE", {
      servicoId: conv.estado_payload.servicoId,
      nomeCompleto: conv.estado_payload.nomeCompleto,
    });
    return true;
  }

  const proposedAt = DateTime.fromISO(propostoEm, {
    zone: ctx.config.cliente.timezone,
  });
  const ageMin = nowTz(ctx).diff(proposedAt, "minutes").minutes;
  if (ageMin >= PROPOSTO_TTL_MINUTES) {
    setConversationState(ctx.store, ctx.waId, "LIVRE", {
      servicoId: conv.estado_payload.servicoId,
      nomeCompleto: conv.estado_payload.nomeCompleto,
    });
    logEvent(ctx.store, "booking.proposto_expirou", {
      wa_id_masked: maskPhone(ctx.waId),
      age_min: ageMin,
    });
    return true;
  }

  return false;
}

/** Preferência explícita por dia/janela que a clínica não atende (ex.: domingo). */
export function isUnavailableWindowPreference(
  preferencia: string,
  config: ClientConfig,
): boolean {
  const pref = normalizeTerm(preferencia);
  const closedDays = ["domingo", "sabado", "segunda", "terca", "quarta", "quinta", "sexta"].filter(
    (d) => !config.funcionamento.dias.some((x) => normalizeTerm(x) === d),
  );
  if (closedDays.some((d) => pref.includes(d))) return true;
  if (config.agenda.feriados.some((f) => pref.includes(f))) return true;
  return false;
}

function formatSlotLine(slot: ProposedSlot, tz: string): string {
  const inicio = DateTime.fromISO(slot.inicio, { zone: tz });
  const dia = WEEKDAY_PT[inicio.weekday] ?? "";
  return `${slot.indice}) ${dia}, ${inicio.toFormat("dd/LL/yyyy")} às ${inicio.toFormat("HH:mm")} com ${slot.profissionalNome}`;
}

function serializeSlots(
  slots: Awaited<ReturnType<typeof buscarHorarios>>,
  servicoId: string,
): ProposedSlot[] {
  return slots.map((slot, index) => ({
    indice: index + 1,
    inicio: slot.inicio.toISO() ?? slot.inicio.toString(),
    fim: slot.fim.toISO() ?? slot.fim.toString(),
    profissionalId: slot.profissionalId,
    profissionalNome: slot.profissionalNome,
    calendarioId: slot.calendarioId,
    servicoId,
  }));
}

function resolveSlotChoice(
  choice: string,
  slots: ProposedSlot[],
  tz: string,
): ProposedSlot | "ambiguous" | null {
  if (isAmbiguousSlotChoice(choice)) return "ambiguous";

  const normalized = normalizeTerm(choice);
  const compact = normalized.replace(/\s+/g, "");
  const asNumber = Number(choice.trim().replace(/[^\d]/g, ""));
  if (
    Number.isInteger(asNumber) &&
    asNumber >= 1 &&
    asNumber <= slots.length &&
    (/^[1-3]$/.test(choice.trim()) || /^(opcao)?[1-3]$/.test(compact))
  ) {
    return slots.find((s) => s.indice === asNumber) ?? null;
  }

  if (
    normalized === "primeiro" ||
    normalized === "1o" ||
    normalized === "a primeira"
  ) {
    return slots[0] ?? null;
  }
  if (normalized === "segundo" || normalized === "2o") {
    return slots[1] ?? null;
  }
  if (normalized === "terceiro" || normalized === "3o") {
    return slots[2] ?? null;
  }

  const matches = slots.filter((slot) => {
    const inicio = DateTime.fromISO(slot.inicio, { zone: tz });
    const hhmm = inicio.toFormat("HH:mm");
    const hhmmCompact = inicio.toFormat("HHmm");
    const day = inicio.toFormat("dd/LL");
    const dayIso = inicio.toISODate() ?? "";
    return (
      normalized.includes(normalizeTerm(hhmm)) ||
      normalized.includes(hhmmCompact) ||
      normalized.includes(normalizeTerm(day)) ||
      normalized.includes(dayIso) ||
      choice.trim() === slot.inicio ||
      normalized.includes(normalizeTerm(slot.profissionalNome))
    );
  });

  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) return "ambiguous";
  return null;
}

async function slotStillFree(
  ctx: BookingContext,
  slot: ProposedSlot,
): Promise<boolean> {
  const tz = ctx.config.cliente.timezone;
  const inicio = DateTime.fromISO(slot.inicio, { zone: tz });
  const fim = DateTime.fromISO(slot.fim, { zone: tz });
  const busyMap = await ctx.calendar.queryBusy({
    calendarIds: [slot.calendarioId],
    timeMin: inicio,
    timeMax: fim,
    timeZone: tz,
  });
  const busy = busyMap.get(slot.calendarioId) ?? [];
  const wanted = Interval.fromDateTimes(inicio, fim);
  return !busy.some((b) => {
    const interval = Interval.fromDateTimes(b.start, b.end);
    return interval.isValid && wanted.overlaps(interval);
  });
}

function formatConfirmationMessage(
  ctx: BookingContext,
  slot: ProposedSlot,
  nome: string,
  servicoNome: string,
): string {
  const tz = ctx.config.cliente.timezone;
  const inicio = DateTime.fromISO(slot.inicio, { zone: tz });
  const dia = WEEKDAY_PT[inicio.weekday] ?? "";
  const local = ctx.config.local;
  const endereco = [
    local.endereco,
    local.complemento,
    local.bairro,
    `${local.cidade}/${local.estado}`,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    `Agendamento confirmado, ${nome.split(" ")[0]}!`,
    `${servicoNome} na ${dia}, ${inicio.toFormat("dd/LL/yyyy")}, às ${inicio.toFormat("HH:mm")}.`,
    `Profissional: ${slot.profissionalNome}.`,
    `Local: ${endereco}.`,
  ].join("\n");
}

export async function proporHorarios(
  ctx: BookingContext,
  input: { servicoId: string; preferencia?: string },
): Promise<Record<string, unknown>> {
  expirePropostoIfNeeded(ctx);

  const servicoId = String(input.servicoId ?? "").trim();
  const servico = ctx.config.servicos.find((s) => s.id === servicoId);
  if (!servico) {
    setConversationState(ctx.store, ctx.waId, "COLETANDO", {
      ...getConversation(ctx.store, ctx.waId)?.estado_payload,
    });
    return {
      ok: false,
      motivo: "servico_invalido",
      mensagem:
        "Serviço inválido. Use buscar_servico / listar_servicos e tente propor_horarios de novo.",
    };
  }

  if (servico.agendavel === false) {
    logEvent(ctx.store, "booking.servico_nao_agendavel", {
      wa_id_masked: maskPhone(ctx.waId),
      servicoId,
    });
    return {
      ok: false,
      motivo: "servico_nao_agendavel",
      mensagem: `${servico.nome} não é agendado pelo assistente. Informe o cliente de que a recepção monta esse horário e acione acionar_handoff.`,
    };
  }

  const conv = ensureConversation(ctx.store, ctx.waId);
  if (conv.estado === "EM_HUMANO") {
    return {
      ok: false,
      motivo: "em_humano",
      mensagem: "Conversa em atendimento humano. Bot silenciado.",
    };
  }

  const agora = nowTz(ctx);
  const slots = await buscarHorarios({
    servicoId,
    config: ctx.config,
    calendar: ctx.calendar,
    agora,
  });

  if (slots.length === 0) {
    recordDemandaNaoAtendida({
      store: ctx.store,
      waId: ctx.waId,
      servicoId,
      janelaDesejada: input.preferencia ?? "janela_padrao_agenda",
      agora,
      timezone: ctx.config.cliente.timezone,
    });
    setConversationState(ctx.store, ctx.waId, "COLETANDO", {
      servicoId,
      nomeCompleto: conv.estado_payload.nomeCompleto,
      preferencia: input.preferencia,
      intencao: `agendar ${servicoId}`,
    });
    return {
      ok: false,
      motivo: "sem_horarios",
      demanda_registrada: true,
      mensagem:
        "Não há horários livres na janela atual (demanda_nao_atendida registrada). Informe isso ao cliente e ofereça handoff se quiser.",
    };
  }

  if (input.preferencia && isUnavailableWindowPreference(input.preferencia, ctx.config)) {
    recordDemandaNaoAtendida({
      store: ctx.store,
      waId: ctx.waId,
      servicoId,
      janelaDesejada: input.preferencia,
      agora,
      timezone: ctx.config.cliente.timezone,
    });
  }

  const proposed = serializeSlots(slots, servicoId);
  setConversationState(ctx.store, ctx.waId, "PROPOSTO", {
    servicoId,
    nomeCompleto: conv.estado_payload.nomeCompleto,
    preferencia: input.preferencia,
    propostoEm: agora.toISO() ?? agora.toString(),
    slots: proposed,
  });

  logEvent(ctx.store, "booking.proposto", {
    wa_id_masked: maskPhone(ctx.waId),
    servicoId,
    slots: proposed.map((s) => s.inicio),
  });

  return {
    ok: true,
    estado: "PROPOSTO",
    servico: { id: servico.id, nome: servico.nome, duracao_min: servico.duracao_min },
    slots: proposed.map((s) => ({
      indice: s.indice,
      inicio: s.inicio,
      fim: s.fim,
      profissionalId: s.profissionalId,
      profissionalNome: s.profissionalNome,
      resumo: formatSlotLine(s, ctx.config.cliente.timezone),
    })),
    instrucao:
      "Apresente os horários ao cliente e peça que escolha UM horário específico (número ou dia/hora). Não escolha por ele. Exija nome completo antes de confirmar_agendamento.",
  };
}

export async function confirmarAgendamento(
  ctx: BookingContext,
  input: { slotEscolhido: string; nomeCompleto: string },
): Promise<Record<string, unknown>> {
  const expired = expirePropostoIfNeeded(ctx);
  if (expired) {
    return {
      ok: false,
      motivo: "proposta_expirada",
      agendado: false,
      mensagem:
        "A proposta de horários expirou (30 min). Chame propor_horarios novamente — não aceite slot antigo.",
    };
  }

  const conv = ensureConversation(ctx.store, ctx.waId);
  if (conv.estado === "EM_HUMANO") {
    return {
      ok: false,
      motivo: "em_humano",
      agendado: false,
      mensagem: "Conversa em atendimento humano. Bot silenciado.",
    };
  }

  const servicoIdProposta =
    conv.estado_payload.servicoId ??
    conv.estado_payload.slots?.[0]?.servicoId;
  if (servicoIdProposta) {
    const servicoProposta = ctx.config.servicos.find(
      (s) => s.id === servicoIdProposta,
    );
    if (servicoProposta && servicoProposta.agendavel === false) {
      logEvent(ctx.store, "booking.servico_nao_agendavel", {
        wa_id_masked: maskPhone(ctx.waId),
        servicoId: servicoIdProposta,
      });
      return {
        ok: false,
        motivo: "servico_nao_agendavel",
        agendado: false,
        mensagem: `${servicoProposta.nome} não é agendado pelo assistente. Informe o cliente de que a recepção monta esse horário e acione acionar_handoff.`,
      };
    }
  }

  const slotsPropostos = conv.estado_payload.slots;
  const podeConfirmar =
    (conv.estado === "PROPOSTO" || conv.estado === "COLETANDO") &&
    !!slotsPropostos &&
    slotsPropostos.length > 0;

  if (!podeConfirmar || !slotsPropostos) {
    setConversationState(ctx.store, ctx.waId, "COLETANDO", {
      servicoId: conv.estado_payload.servicoId,
      nomeCompleto: conv.estado_payload.nomeCompleto,
    });
    return {
      ok: false,
      motivo: "sem_proposta",
      agendado: false,
      mensagem:
        "Não há horários propostos. Use propor_horarios antes de confirmar.",
    };
  }

  const nome = String(input.nomeCompleto ?? "").trim();
  if (!isFullName(nome)) {
    setConversationState(ctx.store, ctx.waId, "COLETANDO", {
      ...conv.estado_payload,
    });
    return {
      ok: false,
      motivo: "nome_obrigatorio",
      agendado: false,
      mensagem:
        "Nome completo obrigatório (nome e sobrenome). Peça o nome completo e só então chame confirmar_agendamento. Não peça CPF, nascimento nem convênio.",
    };
  }

  const choiceRaw = String(input.slotEscolhido ?? "");
  const userText = ctx.userText ?? choiceRaw;
  if (isAmbiguousSlotChoice(choiceRaw) || isAmbiguousSlotChoice(userText)) {
    return {
      ok: false,
      motivo: "escolha_ambigua",
      agendado: false,
      slots: slotsPropostos,
      mensagem:
        "Escolha ambígua (ex.: 'pode ser', 'qualquer um', 'tanto faz'). Pergunte qual dos horários listados o cliente prefere — não escolha por ele e NÃO crie evento.",
    };
  }

  const tz = ctx.config.cliente.timezone;
  const resolved = resolveSlotChoice(choiceRaw, slotsPropostos, tz);

  if (resolved === "ambiguous" || resolved === null) {
    return {
      ok: false,
      motivo: "escolha_ambigua",
      agendado: false,
      slots: slotsPropostos,
      mensagem:
        "Não foi possível identificar um único horário. Peça ao cliente o número da opção ou dia/hora específicos. NÃO crie evento.",
    };
  }

  const propostoEm = DateTime.fromISO(conv.estado_payload.propostoEm ?? "", {
    zone: tz,
  });
  const ageMin = nowTz(ctx).diff(propostoEm, "minutes").minutes;
  let slot = resolved;

  if (!propostoEm.isValid || ageMin >= RECHECK_AFTER_MINUTES) {
    const fresh = await buscarHorarios({
      servicoId: slot.servicoId,
      profissionalId: slot.profissionalId,
      config: ctx.config,
      calendar: ctx.calendar,
      agora: nowTz(ctx),
      limite: 100,
    });
    const stillListed = fresh.some(
      (s) =>
        s.inicio.toISO() === slot.inicio &&
        s.profissionalId === slot.profissionalId,
    );
    if (!stillListed) {
      const reproposta = await proporHorarios(ctx, {
        servicoId: slot.servicoId,
        preferencia: conv.estado_payload.preferencia,
      });
      return {
        ok: false,
        motivo: "slot_indisponivel_recheck",
        agendado: false,
        mensagem:
          "O horário escolhido não está mais disponível após reconsulta. Novos horários foram propostos — peça nova escolha específica.",
        nova_proposta: reproposta,
      };
    }
  }

  const free = await slotStillFree(ctx, slot);
  if (!free) {
    const reproposta = await proporHorarios(ctx, {
      servicoId: slot.servicoId,
      preferencia: conv.estado_payload.preferencia,
    });
    logEvent(ctx.store, "booking.slot_tomado", {
      wa_id_masked: maskPhone(ctx.waId),
      inicio: slot.inicio,
    });
    return {
      ok: false,
      motivo: "slot_tomado",
      agendado: false,
      mensagem:
        "Esse horário acabou de ser ocupado. Seja honesto com o cliente e ofereça os novos horários — não crie evento em cima.",
      nova_proposta: reproposta,
    };
  }

  const servico = ctx.config.servicos.find((s) => s.id === slot.servicoId);
  if (!servico) {
    return {
      ok: false,
      motivo: "servico_invalido",
      agendado: false,
      mensagem: "Serviço da proposta sumiu da config. Acione handoff.",
    };
  }

  const inicio = DateTime.fromISO(slot.inicio, { zone: tz });
  const fimEsperado = inicio.plus({ minutes: servico.duracao_min });
  const fim = DateTime.fromISO(slot.fim, { zone: tz });
  const duracaoOk =
    Math.abs(fim.diff(inicio, "minutes").minutes - servico.duracao_min) < 0.5;

  const title = `${servico.nome} — ${nome}`;
  const created = await ctx.calendar.createEvent({
    calendarId: slot.calendarioId,
    title,
    inicio,
    fim: duracaoOk ? fim : fimEsperado,
    timeZone: tz,
    description: `Agendado via WhatsApp.\nTelefone: ${ctx.waId}\nProfissional: ${slot.profissionalNome}`,
  });

  const mensagem = formatConfirmationMessage(ctx, slot, nome, servico.nome);

  setConversationState(ctx.store, ctx.waId, "CONFIRMADO", {
    servicoId: slot.servicoId,
    nomeCompleto: nome,
    eventId: created.id,
    slots: [slot],
    propostoEm: conv.estado_payload.propostoEm,
  });

  logEvent(ctx.store, "booking.confirmado", {
    wa_id_masked: maskPhone(ctx.waId),
    event_id: created.id,
    inicio: slot.inicio,
    fim: (duracaoOk ? fim : fimEsperado).toISO(),
    duracao_min: servico.duracao_min,
    profissionalId: slot.profissionalId,
  });

  return {
    ok: true,
    agendado: true,
    estado: "CONFIRMADO",
    eventId: created.id,
    titulo: title,
    inicio: inicio.toISO(),
    fim: (duracaoOk ? fim : fimEsperado).toISO(),
    duracao_min: servico.duracao_min,
    profissional: slot.profissionalNome,
    mensagem_cliente: mensagem,
  };
}

/** @deprecated use transferToHuman — mantido só para compat de imports. */
export function markHandoffState(ctx: BookingContext, motivo: string): void {
  const conv = getConversation(ctx.store, ctx.waId);
  const agora = nowTz(ctx);
  setConversationState(ctx.store, ctx.waId, "EM_HUMANO", {
    ...(conv?.estado_payload ?? {}),
    motivoHandoff: motivo,
    emHumanoDesde: agora.toISO() ?? agora.toString(),
  });
}
