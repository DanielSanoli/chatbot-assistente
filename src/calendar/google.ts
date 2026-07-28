/**
 * Google Calendar — stub V0.
 * Disponibilidade e criação de eventos entram em features posteriores.
 */
export function createGoogleCalendarClient() {
  return {
    name: "google_calendar" as const,
    ready: false,
  };
}
