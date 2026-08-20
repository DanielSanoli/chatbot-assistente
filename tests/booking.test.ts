import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmarAgendamento,
  isAmbiguousSlotChoice,
  proporHorarios,
  type BookingContext,
} from "../src/brain/booking.js";
import type { BusyPeriod, CalendarClient } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import {
  getConversation,
  openStore,
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
  const dir = mkdtempSync(join(tmpdir(), "booking-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
  return { store, config };
}

type FakeCalendar = CalendarClient & {
  created: Array<{
    title: string;
    description?: string;
    inicio: DateTime;
    fim: DateTime;
    calendarId: string;
  }>;
  busyById: Record<string, BusyPeriod[]>;
  queryBusyCalls: number;
  deleted: Array<{ calendarId: string; eventId: string }>;
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
    queryBusyCalls: 0,
    async queryBusy({ calendarIds }) {
      calendar.queryBusyCalls += 1;
      const map = new Map<string, BusyPeriod[]>();
      for (const id of calendarIds) {
        map.set(id, busyById[id] ?? []);
      }
      return map;
    },
    async createEvent(input) {
      created.push({
        title: input.title,
        description: input.description,
        inicio: input.inicio,
        fim: input.fim,
        calendarId: input.calendarId,
      });
      return { id: `evt-${created.length}` };
    },
    async deleteEvent({ calendarId, eventId }) {
      deleted.push({ calendarId, eventId });
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

describe("isAmbiguousSlotChoice", () => {
  it("detecta confirmações ambíguas", () => {
    expect(isAmbiguousSlotChoice("pode ser")).toBe(true);
    expect(isAmbiguousSlotChoice("qualquer um")).toBe(true);
    expect(isAmbiguousSlotChoice("tanto faz")).toBe(true);
    expect(isAmbiguousSlotChoice("1")).toBe(false);
    expect(isAmbiguousSlotChoice("terça às 08:00")).toBe(false);
  });
});

describe("agendamento com confirmação", () => {
  it("confirmação ambígua não agenda", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000001";

    const proposta = await proporHorarios(
      ctx(store, config, calendar, waId, agora),
      { servicoId: "limpeza" },
    );
    expect(proposta.ok).toBe(true);

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora, "qualquer um"),
      { slotEscolhido: "qualquer um", nomeCompleto: "Maria Silva" },
    );

    expect(result.agendado).toBe(false);
    expect(result.motivo).toBe("escolha_ambigua");
    expect(calendar.created).toHaveLength(0);
    expect(getConversation(store, waId)?.estado).toBe("PROPOSTO");
  });

  it("agendamento sem nome não conclui", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000002";

    await proporHorarios(ctx(store, config, calendar, waId, agora), {
      servicoId: "limpeza",
    });

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora),
      { slotEscolhido: "1", nomeCompleto: "Maria" },
    );

    expect(result.agendado).toBe(false);
    expect(result.motivo).toBe("nome_obrigatorio");
    expect(calendar.created).toHaveLength(0);
    expect(getConversation(store, waId)?.estado).toBe("COLETANDO");
    expect(getConversation(store, waId)?.estado_payload.slots?.length).toBeGreaterThan(0);
  });

  it("slot tomado entre proposta e confirmação não gera evento e reoferece", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000003";

    const proposta = await proporHorarios(
      ctx(store, config, calendar, waId, agora),
      { servicoId: "limpeza" },
    );
    expect(proposta.ok).toBe(true);
    const slots = (proposta.slots as Array<{ inicio: string; fim: string }>) ?? [];
    expect(slots.length).toBeGreaterThan(0);
    const chosen = slots[0]!;

    // Ocupa o slot escolhido antes da confirmação.
    calendar.busyById["ana@example.com"] = [
      {
        start: DateTime.fromISO(chosen.inicio, { zone: TZ }),
        end: DateTime.fromISO(chosen.fim, { zone: TZ }),
        allDay: false,
      },
    ];

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 2 })),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );

    expect(result.agendado).toBe(false);
    expect(result.motivo).toBe("slot_tomado");
    expect(calendar.created).toHaveLength(0);
    expect(result.nova_proposta).toBeTruthy();
    expect(getConversation(store, waId)?.estado).toBe("PROPOSTO");
  });

  it("expiração do PROPOSTO (30 min) volta para LIVRE e não aceita slot velho", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000004";

    await proporHorarios(ctx(store, config, calendar, waId, agora), {
      servicoId: "limpeza",
    });
    expect(getConversation(store, waId)?.estado).toBe("PROPOSTO");

    const later = agora.plus({ minutes: 31 });
    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, later),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );

    expect(result.agendado).toBe(false);
    expect(result.motivo).toBe("proposta_expirada");
    expect(calendar.created).toHaveLength(0);
    expect(getConversation(store, waId)?.estado).toBe("LIVRE");
  });

  it("evento criado tem duração correta e título só com serviço/nome (sem telefone)", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000005";
    const duracao = config.servicos.find((s) => s.id === "limpeza")!.duracao_min;

    await proporHorarios(ctx(store, config, calendar, waId, agora), {
      servicoId: "limpeza",
    });

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora.plus({ minutes: 1 })),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );

    expect(result.agendado).toBe(true);
    expect(result.duracao_min).toBe(duracao);
    expect(calendar.created).toHaveLength(1);
    const event = calendar.created[0]!;
    expect(event.fim.diff(event.inicio, "minutes").minutes).toBe(duracao);
    expect(event.title).toBe("Limpeza dental — Maria Silva");
    expect(event.title).not.toContain(waId);
    expect(event.title).not.toMatch(/\d{8,}/);
    expect(event.description).toContain(`Telefone: ${waId}`);
    expect(event.description).toMatch(/Profissional:/);
    expect(getConversation(store, waId)?.estado).toBe("CONFIRMADO");
    expect(String(result.mensagem_cliente)).toMatch(/segunda-feira|terça-feira|quarta-feira|quinta-feira|sexta-feira|sábado/i);
    expect(String(result.mensagem_cliente)).toContain("Rua das Flores");
  });

  it("em nenhum cenário de teste cria evento sem escolha específica", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000006";

    await proporHorarios(ctx(store, config, calendar, waId, agora), {
      servicoId: "limpeza",
    });

    for (const ambigua of ["pode ser", "qualquer um", "tanto faz", ""]) {
      await confirmarAgendamento(
        ctx(store, config, calendar, waId, agora, ambigua),
        { slotEscolhido: ambigua, nomeCompleto: "Maria Silva" },
      );
    }

    expect(calendar.created).toHaveLength(0);
  });
});

describe("serviço não agendável", () => {
  it("proporHorarios com agendavel=false não chama calendar.queryBusy", async () => {
    const { store, config } = setup();
    const canal = config.servicos.find((s) => s.id === "canal");
    expect(canal).toBeDefined();
    canal!.agendavel = false;

    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000101";

    const result = await proporHorarios(
      ctx(store, config, calendar, waId, agora),
      { servicoId: "canal" },
    );

    expect(result.ok).toBe(false);
    expect(result.motivo).toBe("servico_nao_agendavel");
    expect(String(result.mensagem)).toMatch(/recepção monta|acionar_handoff/i);
    expect(calendar.queryBusyCalls).toBe(0);
    expect(calendar.created).toHaveLength(0);

    const event = store.db
      .prepare("SELECT tipo, payload_json FROM events WHERE tipo = ?")
      .get("booking.servico_nao_agendavel") as {
      tipo: string;
      payload_json: string;
    };
    expect(event).toBeDefined();
    expect(JSON.parse(event.payload_json).servicoId).toBe("canal");
  });

  it("serviços agendáveis atuais continuam propondo horários", async () => {
    const { store, config } = setup();
    const limpeza = config.servicos.find((s) => s.id === "limpeza");
    expect(limpeza?.agendavel).toBe(true);

    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000102";

    const proposta = await proporHorarios(
      ctx(store, config, calendar, waId, agora),
      { servicoId: "limpeza" },
    );

    expect(proposta.ok).toBe(true);
    expect((proposta.slots as unknown[])?.length).toBeGreaterThan(0);
    expect(calendar.queryBusyCalls).toBeGreaterThan(0);
  });

  it("confirmarAgendamento bloqueia se serviço virou não agendável", async () => {
    const { store, config } = setup();
    const calendar = fakeCalendar();
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const waId = "5511888000103";

    const proposta = await proporHorarios(
      ctx(store, config, calendar, waId, agora),
      { servicoId: "limpeza" },
    );
    expect(proposta.ok).toBe(true);
    const busyCallsAposProposta = calendar.queryBusyCalls;

    const limpeza = config.servicos.find((s) => s.id === "limpeza")!;
    limpeza.agendavel = false;

    const result = await confirmarAgendamento(
      ctx(store, config, calendar, waId, agora),
      { slotEscolhido: "1", nomeCompleto: "Maria Silva" },
    );

    expect(result.ok).toBe(false);
    expect(result.agendado).toBe(false);
    expect(result.motivo).toBe("servico_nao_agendavel");
    expect(calendar.queryBusyCalls).toBe(busyCallsAposProposta);
    expect(calendar.created).toHaveLength(0);
  });
});
