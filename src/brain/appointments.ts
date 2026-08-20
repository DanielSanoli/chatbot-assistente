import { DateTime } from "luxon";
import { maskPhone } from "../channel/mask.js";
import { logEvent } from "../store/index.js";
import {
  listActiveAppointments,
  markAppointmentCancelled,
  type Appointment,
} from "../store/appointments.js";
import {
  ensureConversation,
  setConversationState,
} from "../store/conversations.js";
import {
  formatDataHora,
  proporHorarios,
  type BookingContext,
} from "./booking.js";

/** Motivo devolvido quando a política da casa manda a recepção decidir. */
export const ANTECEDENCIA_INSUFICIENTE = "antecedencia_insuficiente" as const;

/** Validade do "confirma o cancelamento?" pendente, em minutos. */
export const PENDENCIA_TTL_MINUTES = 30;

function nowTz(ctx: BookingContext): DateTime {
  const tz = ctx.config.cliente.timezone;
  return (ctx.agora ?? DateTime.now().setZone(tz)).setZone(tz);
}

function resumo(appointment: Appointment, tz: string): string {
  return `${appointment.servicoNome} — ${formatDataHora(appointment.inicio, tz)} com ${appointment.profissionalNome}`;
}

function toView(appointment: Appointment, tz: string) {
  return {
    id: appointment.id,
    servicoId: appointment.servicoId,
    servico: appointment.servicoNome,
    inicio: appointment.inicio,
    profissional: appointment.profissionalNome,
    resumo: resumo(appointment, tz),
  };
}

type AlvoResolvido =
  | { ok: true; appointment: Appointment }
  | { ok: false; resultado: Record<string, unknown> };

/**
 * Encontra o agendamento sobre o qual o pedido fala. Com mais de um horário
 * futuro, devolve a lista e exige que o cliente diga qual — cancelar o errado
 * é pior do que perguntar de novo.
 */
function resolverAlvo(
  ctx: BookingContext,
  acao: "cancelar" | "remarcar",
  agendamentoId?: number,
): AlvoResolvido {
  const tz = ctx.config.cliente.timezone;
  const ativos = listActiveAppointments(ctx.store, ctx.waId, nowTz(ctx));

  if (ativos.length === 0) {
    return {
      ok: false,
      resultado: {
        ok: false,
        motivo: "sem_agendamento",
        agendamentos: [],
        mensagem:
          "Não há agendamento futuro registrado para este contato. Informe isso ao cliente e ofereça marcar um horário. Não invente que existe compromisso.",
      },
    };
  }

  if (agendamentoId) {
    const alvo = ativos.find((a) => a.id === agendamentoId);
    if (alvo) return { ok: true, appointment: alvo };
    return {
      ok: false,
      resultado: {
        ok: false,
        motivo: "agendamento_invalido",
        agendamentos: ativos.map((a) => toView(a, tz)),
        mensagem:
          "Esse id não corresponde a um agendamento ativo deste contato. Use consultar_agendamento e escolha entre os listados.",
      },
    };
  }

  if (ativos.length === 1) {
    return { ok: true, appointment: ativos[0]! };
  }

  return {
    ok: false,
    resultado: {
      ok: false,
      motivo: "escolha_necessaria",
      agendamentos: ativos.map((a) => toView(a, tz)),
      mensagem: `O cliente tem mais de um horário marcado. Liste os horários e pergunte qual ele quer ${acao}. Não escolha por ele.`,
    },
  };
}

/** Horas até o início do atendimento; negativo se já passou. */
function horasAte(ctx: BookingContext, appointment: Appointment): number {
  const tz = ctx.config.cliente.timezone;
  const inicio = DateTime.fromISO(appointment.inicio, { zone: tz });
  return inicio.diff(nowTz(ctx), "hours").hours;
}

function foraDaJanela(
  ctx: BookingContext,
  appointment: Appointment,
  acao: "cancelar" | "remarcar",
): Record<string, unknown> | null {
  const minimo = ctx.config.agenda.cancelamento_antecedencia_horas;
  const horas = horasAte(ctx, appointment);
  if (horas >= minimo) return null;

  logEvent(ctx.store, "booking.cancelamento_tardio", {
    wa_id_masked: maskPhone(ctx.waId),
    agendamento_id: appointment.id,
    horas_ate: Number(horas.toFixed(2)),
    minimo_horas: minimo,
    acao,
  });

  return {
    ok: false,
    motivo: ANTECEDENCIA_INSUFICIENTE,
    horas_ate: Number(horas.toFixed(2)),
    minimo_horas: minimo,
    agendamento: toView(appointment, ctx.config.cliente.timezone),
    mensagem: `Faltam menos de ${minimo}h para o atendimento — pela política da casa quem decide é a recepção. NÃO diga que cancelou nem que remarcou: acione acionar_handoff.`,
  };
}

export function consultarAgendamentos(
  ctx: BookingContext,
): Record<string, unknown> {
  const tz = ctx.config.cliente.timezone;
  const ativos = listActiveAppointments(ctx.store, ctx.waId, nowTz(ctx));

  return {
    ok: true,
    encontrados: ativos.length,
    agendamentos: ativos.map((a) => toView(a, tz)),
    instrucao:
      ativos.length === 0
        ? "Nenhum horário futuro para este contato. Não afirme que existe agendamento; ofereça marcar."
        : "Responda usando exatamente estes dados. Não invente horário, profissional nem procedimento.",
  };
}

/**
 * Cancelamento em dois passos. O primeiro passo só lê o horário de volta e
 * pede confirmação; o segundo é o que apaga o evento. Um "pode desmarcar"
 * mal interpretado não pode custar a consulta de alguém.
 */
export async function cancelarAgendamento(
  ctx: BookingContext,
  input: { agendamentoId?: number; confirmado?: boolean },
): Promise<Record<string, unknown>> {
  const tz = ctx.config.cliente.timezone;
  const alvo = resolverAlvo(ctx, "cancelar", input.agendamentoId);
  if (!alvo.ok) return alvo.resultado;

  const appointment = alvo.appointment;
  const bloqueio = foraDaJanela(ctx, appointment, "cancelar");
  if (bloqueio) return bloqueio;

  const conv = ensureConversation(ctx.store, ctx.waId);
  const agora = nowTz(ctx);
  const agoraIso = agora.toISO() ?? "";
  const mesmoAlvo = conv.estado_payload.cancelandoId === appointment.id;
  const lidoEm = mesmoAlvo ? conv.estado_payload.cancelandoEm : undefined;
  const idadeMin = lidoEm
    ? agora.diff(DateTime.fromISO(lidoEm, { zone: tz }), "minutes").minutes
    : Number.POSITIVE_INFINITY;

  // O "sim" tem que vir de uma mensagem posterior à leitura do horário e ainda
  // recente. Comparar o relógio do turno impede que o modelo peça e conceda a
  // confirmação sozinho, em duas chamadas seguidas do mesmo turno; a validade
  // curta impede que um "sim" de outro assunto, dias depois, valha como aceite.
  const confirmacaoValida =
    mesmoAlvo && !!lidoEm && lidoEm !== agoraIso && idadeMin <= PENDENCIA_TTL_MINUTES;

  if (!input.confirmado || !confirmacaoValida) {
    setConversationState(ctx.store, ctx.waId, conv.estado, {
      ...conv.estado_payload,
      cancelandoId: appointment.id,
      cancelandoEm:
        mesmoAlvo && lidoEm && idadeMin <= PENDENCIA_TTL_MINUTES
          ? lidoEm
          : agoraIso,
    });
    return {
      ok: false,
      motivo: "confirmacao_necessaria",
      agendamento: toView(appointment, tz),
      mensagem: `Leia o horário de volta ao cliente (${resumo(appointment, tz)}) e pergunte se confirma o cancelamento. Só chame cancelar_agendamento com confirmado=true depois de um sim explícito.`,
    };
  }

  await ctx.calendar.deleteEvent({
    calendarId: appointment.calendarioId,
    eventId: appointment.eventId,
  });

  markAppointmentCancelled(ctx.store, appointment.id, "pedido_do_cliente");

  setConversationState(ctx.store, ctx.waId, "LIVRE", {
    nomeCompleto: appointment.nome,
  });

  logEvent(ctx.store, "booking.cancelado", {
    wa_id_masked: maskPhone(ctx.waId),
    agendamento_id: appointment.id,
    event_id: appointment.eventId,
    servicoId: appointment.servicoId,
    inicio: appointment.inicio,
    horas_de_antecedencia: Number(horasAte(ctx, appointment).toFixed(2)),
    duracao_min: Math.round(
      DateTime.fromISO(appointment.fim, { zone: tz }).diff(
        DateTime.fromISO(appointment.inicio, { zone: tz }),
        "minutes",
      ).minutes,
    ),
  });

  const primeiroNome = appointment.nome.split(" ")[0];
  return {
    ok: true,
    cancelado: true,
    agendamentoId: appointment.id,
    mensagem_cliente: [
      `Cancelado, ${primeiroNome}.`,
      `${appointment.servicoNome} de ${formatDataHora(appointment.inicio, tz)} não está mais na agenda.`,
      "Se quiser marcar outro horário, é só me dizer.",
    ].join("\n"),
  };
}

/**
 * Remarcação = propor horários novos guardando o agendamento de origem. A troca
 * só acontece em confirmar_agendamento, que cria o evento novo antes de soltar
 * o antigo.
 */
export async function remarcarAgendamento(
  ctx: BookingContext,
  input: { agendamentoId?: number; preferencia?: string },
): Promise<Record<string, unknown>> {
  const tz = ctx.config.cliente.timezone;
  const alvo = resolverAlvo(ctx, "remarcar", input.agendamentoId);
  if (!alvo.ok) return alvo.resultado;

  const appointment = alvo.appointment;
  const bloqueio = foraDaJanela(ctx, appointment, "remarcar");
  if (bloqueio) return bloqueio;

  const servico = ctx.config.servicos.find(
    (s) => s.id === appointment.servicoId,
  );
  if (!servico || servico.agendavel === false) {
    return {
      ok: false,
      motivo: "servico_nao_agendavel",
      agendamento: toView(appointment, tz),
      mensagem:
        "Esse procedimento não é remarcado pelo assistente. Informe que a recepção reorganiza esse horário e acione acionar_handoff.",
    };
  }

  const conv = ensureConversation(ctx.store, ctx.waId);
  setConversationState(ctx.store, ctx.waId, "COLETANDO", {
    ...conv.estado_payload,
    servicoId: appointment.servicoId,
    nomeCompleto: appointment.nome,
    cancelandoId: undefined,
    cancelandoEm: undefined,
    remarcandoId: appointment.id,
    intencao: `remarcar ${appointment.servicoId}`,
  });

  const proposta = await proporHorarios(ctx, {
    servicoId: appointment.servicoId,
    preferencia: input.preferencia,
  });

  logEvent(ctx.store, "booking.remarcacao_iniciada", {
    wa_id_masked: maskPhone(ctx.waId),
    agendamento_id: appointment.id,
    servicoId: appointment.servicoId,
    inicio_atual: appointment.inicio,
    propostos: proposta.ok === true,
  });

  return {
    ...proposta,
    remarcando: true,
    agendamento_atual: toView(appointment, tz),
    instrucao:
      proposta.ok === true
        ? `O horário atual (${resumo(appointment, tz)}) só sai da agenda quando o cliente escolher um dos novos. Apresente as opções e peça uma escolha específica; o nome já está registrado, não peça de novo.`
        : String(proposta.mensagem ?? ""),
  };
}
