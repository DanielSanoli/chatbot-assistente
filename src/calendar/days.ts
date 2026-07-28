import type { DateTime } from "luxon";

/** weekday Luxon: 1=segunda … 7=domingo */
const DAY_NAME_TO_WEEKDAY: Record<string, number> = {
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
  domingo: 7,
};

const WEEKDAY_TO_DAY_NAME: Record<number, string> = {
  1: "segunda",
  2: "terca",
  3: "quarta",
  4: "quinta",
  5: "sexta",
  6: "sabado",
  7: "domingo",
};

export function normalizeDayName(name: string): string {
  const key = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  if (key === "terca") return "terca";
  if (key === "sabado") return "sabado";
  return key;
}

export function dayNameToWeekday(name: string): number | null {
  return DAY_NAME_TO_WEEKDAY[normalizeDayName(name)] ?? null;
}

export function weekdayToDayName(weekday: number): string {
  return WEEKDAY_TO_DAY_NAME[weekday] ?? `dia-${weekday}`;
}

export function isWorkingDay(dias: string[], dt: DateTime): boolean {
  const allowed = new Set(
    dias.map(normalizeDayName).filter((d) => dayNameToWeekday(d) !== null),
  );
  const name = weekdayToDayName(dt.weekday);
  return allowed.has(normalizeDayName(name));
}

export function parseHhMm(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}
