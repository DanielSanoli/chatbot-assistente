import { DateTime } from "luxon";
import { google, type calendar_v3 } from "googleapis";

export class CalendarUnavailable extends Error {
  readonly code = "CALENDAR_UNAVAILABLE" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CalendarUnavailable";
  }
}

export type BusyPeriod = {
  start: DateTime;
  end: DateTime;
  allDay: boolean;
};

export type FreeBusyQuery = {
  calendarIds: string[];
  timeMin: DateTime;
  timeMax: DateTime;
  timeZone: string;
};

export type CreateCalendarEventInput = {
  calendarId: string;
  title: string;
  inicio: DateTime;
  fim: DateTime;
  timeZone: string;
  description?: string;
};

export type CreatedCalendarEvent = {
  id: string;
  htmlLink?: string;
};

export type CalendarClient = {
  name: "google_calendar";
  ready: boolean;
  queryBusy: (query: FreeBusyQuery) => Promise<Map<string, BusyPeriod[]>>;
  createEvent: (
    input: CreateCalendarEventInput,
  ) => Promise<CreatedCalendarEvent>;
};

export type GoogleCalendarDeps = {
  /** JSON da service account (string). Default: process.env.GOOGLE_SERVICE_ACCOUNT_JSON */
  serviceAccountJson?: string;
  fetchFreeBusy?: (
    query: FreeBusyQuery,
  ) => Promise<calendar_v3.Schema$FreeBusyResponse>;
  insertEvent?: (
    input: CreateCalendarEventInput,
  ) => Promise<CreatedCalendarEvent>;
};

function parseServiceAccountJson(raw: string): {
  client_email: string;
  private_key: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CalendarUnavailable(
      "GOOGLE_SERVICE_ACCOUNT_JSON não é um JSON válido",
      { cause: err },
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { client_email?: unknown }).client_email !== "string" ||
    typeof (parsed as { private_key?: unknown }).private_key !== "string"
  ) {
    throw new CalendarUnavailable(
      "GOOGLE_SERVICE_ACCOUNT_JSON precisa de client_email e private_key",
    );
  }

  return parsed as { client_email: string; private_key: string };
}

function getJwtAuth(serviceAccountJson?: string) {
  const raw = serviceAccountJson ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new CalendarUnavailable(
      "GOOGLE_SERVICE_ACCOUNT_JSON não configurada",
    );
  }
  const credentials = parseServiceAccountJson(raw);
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

/**
 * Detecta evento de dia inteiro a partir do intervalo freebusy.
 * Bloqueia o dia civil inteiro no timezone informado.
 */
export function isAllDayBusy(
  start: DateTime,
  end: DateTime,
  timeZone: string,
): boolean {
  const startLocal = start.setZone(timeZone);
  const endLocal = end.setZone(timeZone);
  const durationHours = endLocal.diff(startLocal, "hours").hours;

  if (durationHours >= 24) return true;

  const startsAtMidnight =
    startLocal.hour === 0 &&
    startLocal.minute === 0 &&
    startLocal.second === 0 &&
    startLocal.millisecond === 0;
  const endsAtMidnight =
    endLocal.hour === 0 &&
    endLocal.minute === 0 &&
    endLocal.second === 0 &&
    endLocal.millisecond === 0;
  const coversOneCalendarDay =
    startsAtMidnight &&
    endsAtMidnight &&
    endLocal.diff(startLocal, "days").days >= 1;

  return coversOneCalendarDay;
}

export function mapFreeBusyResponse(
  response: calendar_v3.Schema$FreeBusyResponse,
  timeZone: string,
): Map<string, BusyPeriod[]> {
  const result = new Map<string, BusyPeriod[]>();
  const calendars = response.calendars ?? {};

  for (const [calendarId, data] of Object.entries(calendars)) {
    if (data.errors && data.errors.length > 0) {
      const msg = data.errors.map((e) => e.reason ?? e.domain).join(", ");
      throw new CalendarUnavailable(
        `Google freebusy erro no calendário ${calendarId}: ${msg}`,
      );
    }

    const periods: BusyPeriod[] = [];
    for (const busy of data.busy ?? []) {
      if (!busy.start || !busy.end) continue;
      const start = DateTime.fromISO(busy.start, { setZone: true }).setZone(
        timeZone,
      );
      const end = DateTime.fromISO(busy.end, { setZone: true }).setZone(
        timeZone,
      );
      if (!start.isValid || !end.isValid) continue;
      periods.push({
        start,
        end,
        allDay: isAllDayBusy(start, end, timeZone),
      });
    }
    result.set(calendarId, periods);
  }

  return result;
}

export function createGoogleCalendarClient(
  deps: GoogleCalendarDeps = {},
): CalendarClient {
  const fetchFreeBusy =
    deps.fetchFreeBusy ??
    (async (query: FreeBusyQuery) => {
      const auth = getJwtAuth(deps.serviceAccountJson);
      const calendar = google.calendar({ version: "v3", auth });

      try {
        const res = await calendar.freebusy.query({
          requestBody: {
            timeMin: query.timeMin.toUTC().toISO(),
            timeMax: query.timeMax.toUTC().toISO(),
            timeZone: query.timeZone,
            items: query.calendarIds.map((id) => ({ id })),
          },
        });
        return res.data;
      } catch (err) {
        if (err instanceof CalendarUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CalendarUnavailable(
          `Google Calendar indisponível: ${message}`,
          { cause: err },
        );
      }
    });

  const insertEvent =
    deps.insertEvent ??
    (async (input: CreateCalendarEventInput) => {
      const auth = getJwtAuth(deps.serviceAccountJson);
      const calendar = google.calendar({ version: "v3", auth });

      try {
        const res = await calendar.events.insert({
          calendarId: input.calendarId,
          requestBody: {
            summary: input.title,
            description: input.description,
            start: {
              dateTime: input.inicio.toUTC().toISO() ?? undefined,
              timeZone: input.timeZone,
            },
            end: {
              dateTime: input.fim.toUTC().toISO() ?? undefined,
              timeZone: input.timeZone,
            },
          },
        });

        const id = res.data.id;
        if (!id) {
          throw new CalendarUnavailable(
            "Google Calendar não retornou id do evento criado",
          );
        }

        return { id, htmlLink: res.data.htmlLink ?? undefined };
      } catch (err) {
        if (err instanceof CalendarUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CalendarUnavailable(
          `Falha ao criar evento no Google Calendar: ${message}`,
          { cause: err },
        );
      }
    });

  return {
    name: "google_calendar",
    ready: true,
    async queryBusy(query) {
      try {
        const response = await fetchFreeBusy(query);
        return mapFreeBusyResponse(response, query.timeZone);
      } catch (err) {
        if (err instanceof CalendarUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CalendarUnavailable(
          `Google Calendar indisponível: ${message}`,
          { cause: err },
        );
      }
    },
    async createEvent(input) {
      try {
        return await insertEvent(input);
      } catch (err) {
        if (err instanceof CalendarUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CalendarUnavailable(
          `Falha ao criar evento no Google Calendar: ${message}`,
          { cause: err },
        );
      }
    },
  };
}
