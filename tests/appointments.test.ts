import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelarAgendamento,
  consultarAgendamentos,
  remarcarAgendamento,
} from "../src/brain/appointments.js";
import {
  confirmarAgendamento,
  proporHorarios,
  type BookingContext,
} from "../src/brain/booking.js";
import { deleteUserData } from "../src/brain/privacy.js";
import { purgeOldConversations } from "../src/jobs/purge.js";
import type { BusyPeriod, CalendarClient } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import {
  getConversation,
  insertAppointment,
  listActiveAppointments,
  openStore,
  type Appointment,
  type Store,
} from "../src/store/index.js";

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

const TZ = "America/Sao_Paulo";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  ConfigService.reset();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "appointments-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  // clinica-teste: cancelamento_antecedencia_horas = 4.
  const config = ConfigService.load("./clients/clinica-teste.yaml", ENV);
  return { store, config };
}

type FakeCalendar = CalendarClient & {
  created: Array<{ title: string; inicio: DateTime; calendarId: string }>;
  deleted: Array<{ calendarId: string; eventId: string }>;
  busyById: Record<string, BusyPeriod[]>;
  falharDelete: boolean;
};

function fakeCalendar(
  busyById: Record<string, BusyPeriod[]> = {},
): FakeCalendar {
  const created: FakeCalendar["created"] = [];
  const deleted: FakeCalendar["deleted"] = [];
  const calendar: FakeCalendar = {
    name: "google_calendar",
    ready: true,
    busyById,
    created,
    deleted,
    falharDelete: false,
    async queryBusy({ calendarIds }) {
      const map = new Map<string, BusyPeriod[]>();
      for (const id of calendarIds) map.set(id, busyById[id] ?? []);
      return map;
    },
    async createEvent(input) {
      created.push({
        title: input.title,
        inicio: input.inicio,
        calendarId: input.calendarId,
      });
      return { id: `evt-${created.length}` };
    },
    async deleteEvent(input) {
      if (calendar.falharDelete) {
        throw new Error("Google fora do ar");
      }
      deleted.push(input);
    },
  };
  return calendar;
}

function ctx(
  store: Store,
  config: ReturnType<typeof ConfigService.load>,
  calendar: FakeCalendar,
  waId: string,
  agora: DateTime,
  userText?: string,
): BookingContext {
  return { store, config, calendar, waId, agora, userText };
}

function seedAgendamento(
  store: Store,
  waId: string,
  inicio: DateTime,
  overrides: Partial<Appointment> = {},
): Appointment {
  return insertAppointment(store, {
    waId,
    servicoId: overrides.servicoId ?? "limpeza",
    servicoNome: overrides.servicoNome ?? "Limpeza dental",
    profissionalId: "dra-ana",
    profissionalNome: "Dra. Ana Silva",
    calendarioId: "ana@example.com",
    eventId: overrides.eventId ?? "evt-antigo",
    inicio: inicio.toISO() ?? "",
    fim: inicio.plus({ minutes: 45 }).toISO() ?? "",
    nome: overrides.nome ?? "Maria Silva",
  });
}

function eventsOfType(store: Store, tipo: string) {
  return store.db
    .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
    .all(tipo)
    .map((r) => JSON.parse((r as { payload_json: string }).payload_json));
}

describe("agendamento fica registrado ao confirmar", () => {
  it("confirmar_agendamento grava o compromisso e consultar devolve os dados", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000001";

    await proporHorarios(ctx(store, config, calendar, waId, agora), {
      servicoId: "limpeza",
    });
    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 1 })),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );
    expect(result.agendado).toBe(true);
    expect(result.remarcado).toBe(false);

    const consulta = consultarAgendamentos(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 2 })),
    );
    expect(consulta.encontrados).toBe(1);
    const [ag] = consulta.agendamentos as Array<Record<string, unknown>>;
    expect(ag?.servico).toBe("Limpeza dental");
    expect(String(ag?.resumo)).toMatch(/Dra\. Ana Silva/);
    expect(ag?.id).toBe(result.agendamentoId);
  });

  it("consultar sem histórico não inventa agendamento", () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });

    const consulta = consultarAgendamentos(
      ctx(store, config, calendar, "5511777000002", agora),
    );
    expect(consulta.encontrados).toBe(0);
    expect(consulta.agendamentos).toEqual([]);
    expect(String(consulta.instrucao)).toMatch(/Não afirme/i);
  });

  it("agendamento passado some da lista de ativos", () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000003";

    seedAgendamento(store, waId, agora.minus({ days: 2 }));
    const consulta = consultarAgendamentos(
      ctx(store, config, calendar, waId, agora),
    );
    expect(consulta.encontrados).toBe(0);
  });
});

describe("cancelamento", () => {
  it("primeira chamada só pede confirmação e NÃO apaga o evento", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000010";
    seedAgendamento(store, waId, agora.plus({ days: 2 }));

    const result = await cancelarAgendamento(
      ctx(store, config, calendar, waId, agora, "quero desmarcar"),
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.motivo).toBe("confirmacao_necessaria");
    expect(calendar.deleted).toHaveLength(0);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
  });

  it("confirmado=true no mesmo turno da leitura ainda não cancela", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000011";
    seedAgendamento(store, waId, agora.plus({ days: 2 }));

    await cancelarAgendamento(ctx(store, config, calendar, waId, agora), {});
    // Mesmo relógio = mesmo turno: o modelo estaria confirmando sozinho.
    const result = await cancelarAgendamento(
      ctx(store, config, calendar, waId, agora),
      { confirmado: true },
    );

    expect(result.motivo).toBe("confirmacao_necessaria");
    expect(calendar.deleted).toHaveLength(0);
  });

  it("confirmação em turno seguinte apaga o evento e libera a vaga", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000012";
    const agendamento = seedAgendamento(store, waId, agora.plus({ days: 2 }));

    await cancelarAgendamento(ctx(store, config, calendar, waId, agora), {});
    const result = await cancelarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 1 }), "sim"),
      { confirmado: true },
    );

    expect(result.ok).toBe(true);
    expect(result.cancelado).toBe(true);
    expect(calendar.deleted).toEqual([
      { calendarId: "ana@example.com", eventId: agendamento.eventId },
    ]);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(0);
    expect(String(result.mensagem_cliente)).toMatch(/Cancelado, Maria/);
    expect(getConversation(store, waId)?.estado).toBe("LIVRE");

    const [evento] = eventsOfType(store, "booking.cancelado");
    expect(evento.duracao_min).toBe(45);
    expect(String(evento.wa_id_masked)).not.toContain(waId);
  });

  it("cancelar em cima da hora não apaga nada e devolve antecedencia_insuficiente", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000013";
    // 2h de antecedência, política da clinica-teste exige 4h.
    seedAgendamento(store, waId, agora.plus({ hours: 2 }));

    const result = await cancelarAgendamento(
      ctx(store, config, calendar, waId, agora),
      { confirmado: true },
    );

    expect(result.motivo).toBe("antecedencia_insuficiente");
    expect(result.minimo_horas).toBe(4);
    expect(calendar.deleted).toHaveLength(0);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
    expect(eventsOfType(store, "booking.cancelamento_tardio")).toHaveLength(1);
  });

  it("com dois horários marcados exige escolha antes de cancelar", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000014";
    seedAgendamento(store, waId, agora.plus({ days: 2 }), {
      eventId: "evt-a",
    });
    seedAgendamento(store, waId, agora.plus({ days: 5 }), {
      eventId: "evt-b",
      servicoId: "clareamento",
      servicoNome: "Clareamento dental",
    });

    const result = await cancelarAgendamento(
      ctx(store, config, calendar, waId, agora),
      { confirmado: true },
    );

    expect(result.motivo).toBe("escolha_necessaria");
    expect((result.agendamentos as unknown[]).length).toBe(2);
    expect(calendar.deleted).toHaveLength(0);
  });

  it("cancelar sem agendamento não erra e não afirma que existia", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });

    const result = await cancelarAgendamento(
      ctx(store, config, calendar, "5511777000015", agora),
      { confirmado: true },
    );

    expect(result.motivo).toBe("sem_agendamento");
    expect(calendar.deleted).toHaveLength(0);
  });
});

describe("remarcação", () => {
  it("propõe horários novos sem soltar o antigo antes da confirmação", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000020";
    const original = seedAgendamento(store, waId, agora.plus({ days: 3 }));

    const result = await remarcarAgendamento(
      ctx(store, config, calendar, waId, agora),
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.remarcando).toBe(true);
    expect((result.slots as unknown[]).length).toBeGreaterThan(0);
    expect(calendar.deleted).toHaveLength(0);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);

    const conv = getConversation(store, waId);
    expect(conv?.estado).toBe("PROPOSTO");
    expect(conv?.estado_payload.remarcandoId).toBe(original.id);
  });

  it("confirmar troca o evento: cria o novo e só então apaga o antigo", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000021";
    const original = seedAgendamento(store, waId, agora.plus({ days: 3 }));

    await remarcarAgendamento(ctx(store, config, calendar, waId, agora), {});
    // Nome não é pedido de novo: já veio do agendamento original.
    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 1 })),
      { slotEscolhido: "1", nomeCompleto: "" },
    );

    expect(result.agendado).toBe(true);
    expect(result.remarcado).toBe(true);
    expect(calendar.created).toHaveLength(1);
    expect(calendar.deleted).toEqual([
      { calendarId: "ana@example.com", eventId: original.eventId },
    ]);
    expect(String(result.mensagem_cliente)).toMatch(/remarquei/i);

    const ativos = listActiveAppointments(store, waId, agora);
    expect(ativos).toHaveLength(1);
    expect(ativos[0]?.remarcadoDeId).toBe(original.id);
    expect(eventsOfType(store, "booking.remarcado")).toHaveLength(1);
    expect(eventsOfType(store, "booking.confirmado")).toHaveLength(0);
  });

  it("falha ao apagar o evento antigo não tira o horário novo do paciente", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000022";
    seedAgendamento(store, waId, agora.plus({ days: 3 }));

    await remarcarAgendamento(ctx(store, config, calendar, waId, agora), {});
    calendar.falharDelete = true;

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 1 })),
      { slotEscolhido: "1", nomeCompleto: "" },
    );

    expect(result.agendado).toBe(true);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
    const [orfao] = eventsOfType(store, "booking.remarcacao_evento_orfao");
    expect(orfao.event_id_antigo).toBe("evt-antigo");
  });

  it("remarcar em cima da hora não propõe horário e devolve o bloqueio", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000023";
    seedAgendamento(store, waId, agora.plus({ hours: 1 }));

    const result = await remarcarAgendamento(
      ctx(store, config, calendar, waId, agora),
      {},
    );

    expect(result.motivo).toBe("antecedencia_insuficiente");
    expect(result.slots).toBeUndefined();
    expect(calendar.created).toHaveLength(0);
  });

  it("proposta de remarcação expirada volta para LIVRE e esquece a origem", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000024";
    seedAgendamento(store, waId, agora.plus({ days: 3 }));

    await remarcarAgendamento(ctx(store, config, calendar, waId, agora), {});

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 31 })),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );

    expect(result.motivo).toBe("proposta_expirada");
    expect(calendar.created).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
    const conv = getConversation(store, waId);
    expect(conv?.estado).toBe("LIVRE");
    expect(conv?.estado_payload.remarcandoId).toBeUndefined();
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
  });
});

describe("agendamento e privacidade", () => {
  it("excluir meus dados preserva o compromisso futuro e apaga o histórico", () => {
    const { store } = setup();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511777000030";

    seedAgendamento(store, waId, agora.plus({ days: 3 }), { eventId: "futuro" });
    seedAgendamento(store, waId, agora.minus({ days: 3 }), {
      eventId: "passado",
    });

    const result = deleteUserData(store, waId, agora);

    expect(result.agendamentosRemovidos).toBe(1);
    const restantes = listActiveAppointments(store, waId, agora);
    expect(restantes).toHaveLength(1);
    expect(restantes[0]?.eventId).toBe("futuro");
  });

  it("expurgo remove agendamento antigo pela data do atendimento", () => {
    const { store, config } = setup();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });

    seedAgendamento(store, "5511777000031", agora.minus({ days: 200 }));
    seedAgendamento(store, "5511777000032", agora.minus({ days: 10 }));

    const result = purgeOldConversations(store, config.privacidade.retencao_dias, {
      now: agora,
      timezone: TZ,
    });

    expect(result.agendamentos).toBe(1);
    const total = store.db
      .prepare(`SELECT COUNT(*) as n FROM appointments`)
      .get() as { n: number };
    expect(total.n).toBe(1);
  });
});
