import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import {
  CalendarUnavailable,
  createGoogleCalendarClient,
  type BusyPeriod,
  type CalendarClient,
} from "../src/calendar/google.js";
import { buscarHorarios, selecionarHorarios } from "../src/calendar/slots.js";
import { ConfigService } from "../src/config/index.js";
import type { ClientConfig } from "../src/config/schema.js";

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

afterEach(() => {
  ConfigService.reset();
});

function loadConfig(): ClientConfig {
  return ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
}

function fakeCalendar(
  busyById: Record<string, BusyPeriod[]>,
  options?: { fail?: boolean },
): CalendarClient {
  return {
    name: "google_calendar",
    ready: true,
    async queryBusy({ calendarIds }) {
      if (options?.fail) {
        throw new CalendarUnavailable("Google fora do ar (fake)");
      }
      const map = new Map<string, BusyPeriod[]>();
      for (const id of calendarIds) {
        map.set(id, busyById[id] ?? []);
      }
      return map;
    },
  };
}

function busy(startIso: string, endIso: string, allDay = false): BusyPeriod {
  return {
    start: DateTime.fromISO(startIso, { zone: TZ }),
    end: DateTime.fromISO(endIso, { zone: TZ }),
    allDay,
  };
}

function atDay(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

describe("selecionarHorarios", () => {
  it("prioriza dias diferentes antes de repetir o mesmo dia", () => {
    const base = DateTime.fromISO("2026-07-28T08:00:00", { zone: TZ });
    const mk = (dayOffset: number, hour: number) => {
      const inicio = base.plus({ days: dayOffset }).set({ hour });
      return {
        inicio,
        fim: inicio.plus({ minutes: 45 }),
        profissionalId: "dra-ana",
        profissionalNome: "Ana",
        servicoId: "limpeza",
        calendarioId: "ana@example.com",
      };
    };

    const picked = selecionarHorarios([
      mk(0, 8),
      mk(0, 9),
      mk(0, 10),
      mk(1, 8),
      mk(2, 8),
    ]);

    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((p) => p.inicio.toISODate())).size).toBe(3);
  });
});

describe("buscarHorarios", () => {
  it("aceite: limpeza com evento 10h-11h na terça não colide, não passa das 18h, ignora domingo/feriado", async () => {
    const config = loadConfig();
    const terca = DateTime.fromISO("2026-07-28", { zone: TZ });
    expect(terca.weekday).toBe(2);

    const calendar = fakeCalendar({
      "ana@example.com": [
        busy("2026-07-28T10:00:00", "2026-07-28T11:00:00"),
      ],
    });

    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar,
      agora,
      janela: {
        inicio: terca.startOf("day"),
        fim: terca.plus({ days: 10 }).endOf("day"),
      },
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);

    const eventoStart = DateTime.fromISO("2026-07-28T10:00:00", { zone: TZ });
    const eventoEnd = DateTime.fromISO("2026-07-28T11:00:00", { zone: TZ });

    for (const slot of slots) {
      expect(slot.inicio.weekday).not.toBe(7);
      expect(config.agenda.feriados).not.toContain(slot.inicio.toISODate());
      expect(slot.fim <= atDay(slot.inicio, "18:00")).toBe(true);
      expect(slot.fim <= eventoStart || slot.inicio >= eventoEnd).toBe(true);
    }

    const grade = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar,
      agora,
      janela: { inicio: terca.startOf("day"), fim: terca.endOf("day") },
      limite: 100,
    });

    expect(grade.length).toBeGreaterThan(0);
    const times = grade.map((s) => s.inicio.toFormat("HH:mm"));
    expect(times).toContain("08:00");
    expect(times).toContain("11:00");
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:15");
    expect(times).not.toContain("10:30");
    expect(times).not.toContain("10:45");

    for (const slot of grade) {
      expect(slot.fim <= eventoStart || slot.inicio >= eventoEnd).toBe(true);
      expect(slot.fim <= atDay(terca, "18:00")).toBe(true);
      const bufferEnd = slot.inicio.plus({
        minutes:
          45 + config.agenda.buffer_entre_atendimentos_min,
      });
      expect(bufferEnd <= eventoStart || slot.inicio >= eventoEnd).toBe(true);
    }
  });

  it("dia sem funcionamento (domingo) não oferece horários", async () => {
    const config = loadConfig();
    const domingo = DateTime.fromISO("2026-08-02", { zone: TZ });
    expect(domingo.weekday).toBe(7);

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({}),
      agora: domingo.set({ hour: 7 }),
      janela: { inicio: domingo.startOf("day"), fim: domingo.endOf("day") },
      limite: 100,
    });

    expect(slots).toEqual([]);
  });

  it("feriado da config não oferece horários", async () => {
    const config = loadConfig();
    const feriado = DateTime.fromISO("2026-11-20", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({}),
      agora: feriado.minus({ days: 1 }).set({ hour: 8 }),
      janela: { inicio: feriado.startOf("day"), fim: feriado.endOf("day") },
      limite: 100,
    });

    expect(slots).toEqual([]);
  });

  it("agenda 100% cheia retorna lista vazia (não erro)", async () => {
    const config = loadConfig();
    const dia = DateTime.fromISO("2026-07-28", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({
        "ana@example.com": [
          busy("2026-07-28T08:00:00", "2026-07-28T18:00:00"),
        ],
      }),
      agora: dia.minus({ days: 1 }).set({ hour: 8 }),
      janela: { inicio: dia.startOf("day"), fim: dia.endOf("day") },
      limite: 100,
    });

    expect(slots).toEqual([]);
  });

  it("evento de dia inteiro bloqueia o dia todo", async () => {
    const config = loadConfig();
    const dia = DateTime.fromISO("2026-07-28", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({
        "ana@example.com": [
          busy("2026-07-28T00:00:00", "2026-07-29T00:00:00", true),
        ],
      }),
      agora: dia.minus({ days: 1 }).set({ hour: 8 }),
      janela: { inicio: dia.startOf("day"), fim: dia.endOf("day") },
      limite: 100,
    });

    expect(slots).toEqual([]);
  });

  it("serviço que não cabe no restante do expediente não é oferecido", async () => {
    const config = loadConfig();
    const sabado = DateTime.fromISO("2026-08-01", { zone: TZ });
    expect(sabado.weekday).toBe(6);

    const slots = await buscarHorarios({
      servicoId: "canal",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({
        "ana@example.com": [
          busy("2026-08-01T09:00:00", "2026-08-01T11:00:00"),
        ],
      }),
      agora: sabado.minus({ days: 1 }).set({ hour: 8 }),
      janela: { inicio: sabado.startOf("day"), fim: sabado.endOf("day") },
      limite: 100,
    });

    expect(slots).toEqual([]);
  });

  it("sábado usa horário mais curto (por_dia) e não passa das 13h", async () => {
    const config = loadConfig();
    const sabado = DateTime.fromISO("2026-08-01", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({}),
      agora: sabado.minus({ days: 1 }).set({ hour: 8 }),
      janela: { inicio: sabado.startOf("day"), fim: sabado.endOf("day") },
      limite: 100,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.inicio.weekday).toBe(6);
      expect(slot.inicio >= atDay(sabado, "09:00")).toBe(true);
      expect(slot.fim <= atDay(sabado, "13:00")).toBe(true);
      expect(slot.fim <= atDay(sabado, "12:00")).toBe(true);
    }
  });

  it("virada de dia: antecedência respeita timezone America/Sao_Paulo", async () => {
    const config = loadConfig();
    const agora = DateTime.fromISO("2026-07-27T03:00:00", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "limpeza",
      profissionalId: "dra-ana",
      config,
      calendar: fakeCalendar({}),
      agora,
      janela: { inicio: agora.startOf("day"), fim: agora.endOf("day") },
      limite: 100,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.inicio.zoneName).toBe(TZ);
      expect(slot.inicio >= agora.plus({ hours: 2 })).toBe(true);
    }
  });

  it("sem profissionalId considera todos que atendem o serviço e devolve profissional", async () => {
    const config = loadConfig();
    const dia = DateTime.fromISO("2026-07-28", { zone: TZ });

    const slots = await buscarHorarios({
      servicoId: "consulta",
      config,
      calendar: fakeCalendar({}),
      agora: dia.minus({ days: 1 }).set({ hour: 8 }),
      janela: {
        inicio: dia.startOf("day"),
        fim: dia.plus({ days: 5 }).endOf("day"),
      },
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(["dra-ana", "dr-bruno"]).toContain(slot.profissionalId);
      expect(slot.profissionalNome.length).toBeGreaterThan(0);
    }
  });

  it("Google fora do ar lança CalendarUnavailable", async () => {
    const config = loadConfig();
    await expect(
      buscarHorarios({
        servicoId: "limpeza",
        profissionalId: "dra-ana",
        config,
        calendar: fakeCalendar({}, { fail: true }),
        agora: DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ }),
      }),
    ).rejects.toBeInstanceOf(CalendarUnavailable);
  });

  it("createGoogleCalendarClient propaga CalendarUnavailable em falha de rede", async () => {
    const client = createGoogleCalendarClient({
      fetchFreeBusy: async () => {
        throw new Error("network down");
      },
    });

    await expect(
      client.queryBusy({
        calendarIds: ["primary"],
        timeMin: DateTime.now().setZone(TZ),
        timeMax: DateTime.now().setZone(TZ).plus({ days: 1 }),
        timeZone: TZ,
      }),
    ).rejects.toBeInstanceOf(CalendarUnavailable);
  });
});
