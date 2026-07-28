import { DateTime, Interval } from "luxon";
import type { ClientConfig, Profissional, Servico } from "../config/schema.js";
import {
  isWorkingDay,
  normalizeDayName,
  parseHhMm,
  weekdayToDayName,
} from "./days.js";
import type { BusyPeriod, CalendarClient } from "./google.js";

export type HorarioLivre = {
  inicio: DateTime;
  fim: DateTime;
  profissionalId: string;
  profissionalNome: string;
  servicoId: string;
  calendarioId: string;
};

export type BuscarHorariosInput = {
  servicoId: string;
  profissionalId?: string;
  /** Override opcional da janela (Luxon, no timezone do cliente). */
  janela?: {
    inicio?: DateTime;
    fim?: DateTime;
  };
  config: ClientConfig;
  calendar: CalendarClient;
  /** Relógio injetável — sempre DateTime com zone do cliente. */
  agora?: DateTime;
  /** Máximo de horários retornados (default 3). Use valor alto só em testes. */
  limite?: number;
};

function atLocalTime(day: DateTime, hhmm: string): DateTime {
  const { hour, minute } = parseHhMm(hhmm);
  return day.set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
}

function dayHours(
  config: ClientConfig,
  day: DateTime,
): { inicio: DateTime; fim: DateTime } | null {
  if (!isWorkingDay(config.funcionamento.dias, day)) {
    return null;
  }

  const dayName = normalizeDayName(weekdayToDayName(day.weekday));
  const special =
    config.funcionamento.por_dia[dayName] ??
    Object.entries(config.funcionamento.por_dia).find(
      ([key]) => normalizeDayName(key) === dayName,
    )?.[1];
  const horario = special ?? config.funcionamento.horario;
  return {
    inicio: atLocalTime(day, horario.inicio),
    fim: atLocalTime(day, horario.fim),
  };
}

function workingIntervals(config: ClientConfig, day: DateTime): Interval[] {
  const hours = dayHours(config, day);
  if (!hours) return [];

  let intervals: Interval[] = [
    Interval.fromDateTimes(hours.inicio, hours.fim),
  ];

  const lunch = config.funcionamento.intervalo_almoco;
  if (lunch) {
    const lunchInterval = Interval.fromDateTimes(
      atLocalTime(day, lunch.inicio),
      atLocalTime(day, lunch.fim),
    );
    intervals = intervals.flatMap((interval) => {
      const parts = interval.difference(lunchInterval);
      return parts.filter((p) => p.isValid && p.toDuration().as("minutes") > 0);
    });
  }

  return intervals.filter((i) => i.isValid);
}

function isHoliday(config: ClientConfig, day: DateTime): boolean {
  const iso = day.toISODate();
  if (!iso) return false;
  return config.agenda.feriados.includes(iso);
}

function expandAllDayBusy(
  busy: BusyPeriod[],
  day: DateTime,
  config: ClientConfig,
): BusyPeriod[] {
  const hours = dayHours(config, day);
  if (!hours) return busy;

  return busy.map((b) => {
    if (!b.allDay) return b;
    // Evento de dia inteiro que toca este dia civil → bloqueia o expediente todo.
    const dayInterval = Interval.fromDateTimes(
      day.startOf("day"),
      day.endOf("day"),
    );
    const busyInterval = Interval.fromDateTimes(b.start, b.end);
    if (!dayInterval.overlaps(busyInterval)) return b;
    return {
      start: hours.inicio,
      end: hours.fim,
      allDay: true,
    };
  });
}

function subtractBusy(
  free: Interval[],
  busy: BusyPeriod[],
): Interval[] {
  let result = free;
  for (const b of busy) {
    const busyInterval = Interval.fromDateTimes(b.start, b.end);
    if (!busyInterval.isValid) continue;
    result = result.flatMap((interval) =>
      interval
        .difference(busyInterval)
        .filter((p) => p.isValid && p.toDuration().as("minutes") > 0),
    );
  }
  return result;
}

function alignToGrade(dt: DateTime, passoMin: number): DateTime {
  let cleared = dt.set({ second: 0, millisecond: 0 });
  if (cleared < dt) {
    cleared = cleared.plus({ minutes: 1 });
  }
  const minutes = cleared.hour * 60 + cleared.minute;
  const rem = minutes % passoMin;
  if (rem === 0) return cleared;
  return cleared.plus({ minutes: passoMin - rem });
}

function generateStarts(
  interval: Interval,
  duracaoMin: number,
  bufferMin: number,
  passoMin: number,
  notBefore: DateTime,
): DateTime[] {
  const starts: DateTime[] = [];
  if (!interval.start || !interval.end) return starts;

  const needMin = duracaoMin + bufferMin;
  const earliest = DateTime.max(interval.start, notBefore);
  if (earliest >= interval.end) return starts;

  for (
    let start = alignToGrade(earliest, passoMin);
    start.isValid && start < interval.end;
    start = start.plus({ minutes: passoMin })
  ) {
    if (start < earliest) continue;
    const endWithBuffer = start.plus({ minutes: needMin });
    if (endWithBuffer <= interval.end) {
      starts.push(start);
    }
  }

  return starts;
}

/**
 * Seleciona no máximo 3 horários, priorizando os mais próximos.
 * Evita dois no mesmo dia se houver alternativa em dias diferentes.
 */
export function selecionarHorarios(
  candidatos: HorarioLivre[],
  max = 3,
): HorarioLivre[] {
  const sorted = [...candidatos].sort(
    (a, b) => a.inicio.toMillis() - b.inicio.toMillis(),
  );
  const selected: HorarioLivre[] = [];
  const days = new Set<string>();

  for (const slot of sorted) {
    if (selected.length >= max) break;
    const day = slot.inicio.toISODate();
    if (!day || days.has(day)) continue;
    selected.push(slot);
    days.add(day);
  }

  if (selected.length < max) {
    for (const slot of sorted) {
      if (selected.length >= max) break;
      const already = selected.some(
        (s) =>
          s.inicio.toMillis() === slot.inicio.toMillis() &&
          s.profissionalId === slot.profissionalId,
      );
      if (already) continue;
      selected.push(slot);
    }
    selected.sort((a, b) => a.inicio.toMillis() - b.inicio.toMillis());
  }

  return selected;
}

function resolveProfissionais(
  config: ClientConfig,
  servicoId: string,
  profissionalId?: string,
): Profissional[] {
  const elegiveis = config.profissionais.filter((p) =>
    p.servicos.includes(servicoId),
  );

  if (profissionalId) {
    const one = elegiveis.find((p) => p.id === profissionalId);
    if (!one) {
      throw new Error(
        `Profissional "${profissionalId}" não atende o serviço "${servicoId}"`,
      );
    }
    return [one];
  }

  return elegiveis;
}

export async function buscarHorarios(
  input: BuscarHorariosInput,
): Promise<HorarioLivre[]> {
  const { config, calendar, servicoId } = input;
  const tz = config.cliente.timezone;
  const agora = (input.agora ?? DateTime.now().setZone(tz)).setZone(tz);

  const servico: Servico | undefined = config.servicos.find(
    (s) => s.id === servicoId,
  );
  if (!servico) {
    throw new Error(`Serviço não encontrado: ${servicoId}`);
  }

  const profissionais = resolveProfissionais(
    config,
    servicoId,
    input.profissionalId,
  );
  if (profissionais.length === 0) {
    return [];
  }

  const janelaInicio =
    input.janela?.inicio?.setZone(tz) ??
    agora.plus({ hours: config.agenda.antecedencia_minima_horas });
  const janelaFim =
    input.janela?.fim?.setZone(tz) ??
    agora.plus({ days: config.agenda.janela_maxima_dias }).endOf("day");

  const notBefore = DateTime.max(
    janelaInicio,
    agora.plus({ hours: config.agenda.antecedencia_minima_horas }),
  );

  const calendarIds = [...new Set(profissionais.map((p) => p.calendario_id))];
  const busyByCalendar = await calendar.queryBusy({
    calendarIds,
    timeMin: janelaInicio.startOf("day"),
    timeMax: janelaFim.endOf("day"),
    timeZone: tz,
  });

  const candidatos: HorarioLivre[] = [];
  let day = janelaInicio.startOf("day");

  while (day <= janelaFim.startOf("day")) {
    if (!isHoliday(config, day) && isWorkingDay(config.funcionamento.dias, day)) {
      const freeBase = workingIntervals(config, day);

      for (const profissional of profissionais) {
        const rawBusy = busyByCalendar.get(profissional.calendario_id) ?? [];
        const busy = expandAllDayBusy(rawBusy, day, config);
        const free = subtractBusy(freeBase, busy);

        for (const interval of free) {
          const starts = generateStarts(
            interval,
            servico.duracao_min,
            config.agenda.buffer_entre_atendimentos_min,
            config.agenda.passo_grade_min,
            notBefore,
          );

          for (const inicio of starts) {
            if (inicio < janelaInicio || inicio > janelaFim) continue;
            const fim = inicio.plus({ minutes: servico.duracao_min });
            // Serviço que não cabe no restante do expediente já é filtrado por generateStarts
            // (needMin = duracao + buffer <= fim do intervalo livre/expediente).
            candidatos.push({
              inicio,
              fim,
              profissionalId: profissional.id,
              profissionalNome: profissional.nome,
              servicoId: servico.id,
              calendarioId: profissional.calendario_id,
            });
          }
        }
      }
    }

    day = day.plus({ days: 1 });
  }

  // Um horário por instante: se vários profissionais livres, mantém o primeiro elegível.
  const dedup = new Map<string, HorarioLivre>();
  for (const slot of candidatos.sort(
    (a, b) => a.inicio.toMillis() - b.inicio.toMillis(),
  )) {
    const key = slot.inicio.toISO() ?? String(slot.inicio.toMillis());
    if (!dedup.has(key)) {
      dedup.set(key, slot);
    }
  }

  return selecionarHorarios([...dedup.values()], input.limite ?? 3);
}
