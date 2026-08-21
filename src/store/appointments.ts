import { DateTime } from "luxon";
import type { Store } from "./db.js";

export const APPOINTMENT_STATUSES = [
  "CONFIRMADO",
  "CANCELADO",
  "REMARCADO",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export type Appointment = {
  id: number;
  waId: string;
  servicoId: string;
  servicoNome: string;
  profissionalId: string;
  profissionalNome: string;
  calendarioId: string;
  eventId: string;
  /** ISO com offset, no timezone do cliente. */
  inicio: string;
  fim: string;
  nome: string;
  status: AppointmentStatus;
  criadoEm: string;
  atualizadoEm: string;
  canceladoEm: string | null;
  motivoCancelamento: string | null;
  /** Preenchido quando este agendamento nasceu de uma remarcação. */
  remarcadoDeId: number | null;
};

export type NewAppointment = Omit<
  Appointment,
  | "id"
  | "status"
  | "criadoEm"
  | "atualizadoEm"
  | "canceladoEm"
  | "motivoCancelamento"
  | "remarcadoDeId"
> & {
  /** Só numa remarcação: o agendamento que este substitui. */
  remarcadoDeId?: number | null;
};

/** Dois CONFIRMADO no mesmo (calendario_id, inicio). Não é erro genérico. */
export class SlotCollisionError extends Error {
  readonly code = "SLOT_COLLISION" as const;

  constructor(calendarioId: string, inicio: string) {
    super(
      `Horário já confirmado neste calendário (${calendarioId} @ ${inicio})`,
    );
    this.name = "SlotCollisionError";
  }
}

function isSqliteUniqueConstraint(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    (err instanceof Error && /UNIQUE constraint failed/i.test(err.message))
  );
}

type AppointmentDbRow = {
  id: number;
  wa_id: string;
  servico_id: string;
  servico_nome: string;
  profissional_id: string;
  profissional_nome: string;
  calendario_id: string;
  event_id: string;
  inicio: string;
  fim: string;
  nome: string;
  status: string;
  criado_em: string;
  atualizado_em: string;
  cancelado_em: string | null;
  motivo_cancelamento: string | null;
  remarcado_de_id: number | null;
};

const SELECT_COLUMNS = `id, wa_id, servico_id, servico_nome, profissional_id,
       profissional_nome, calendario_id, event_id, inicio, fim, nome, status,
       criado_em, atualizado_em, cancelado_em, motivo_cancelamento,
       remarcado_de_id`;

function toAppointment(row: AppointmentDbRow): Appointment {
  return {
    id: row.id,
    waId: row.wa_id,
    servicoId: row.servico_id,
    servicoNome: row.servico_nome,
    profissionalId: row.profissional_id,
    profissionalNome: row.profissional_nome,
    calendarioId: row.calendario_id,
    eventId: row.event_id,
    inicio: row.inicio,
    fim: row.fim,
    nome: row.nome,
    status: (APPOINTMENT_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as AppointmentStatus)
      : "CONFIRMADO",
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    canceladoEm: row.cancelado_em,
    motivoCancelamento: row.motivo_cancelamento,
    remarcadoDeId: row.remarcado_de_id,
  };
}

export function insertAppointment(
  store: Store,
  input: NewAppointment,
): Appointment {
  try {
    const result = store.db
      .prepare(
        `INSERT INTO appointments
         (wa_id, servico_id, servico_nome, profissional_id, profissional_nome,
          calendario_id, event_id, inicio, fim, nome, status, remarcado_de_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', ?)`,
      )
      .run(
        input.waId,
        input.servicoId,
        input.servicoNome,
        input.profissionalId,
        input.profissionalNome,
        input.calendarioId,
        input.eventId,
        input.inicio,
        input.fim,
        input.nome,
        input.remarcadoDeId ?? null,
      );

    const created = getAppointment(store, Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Falha ao gravar agendamento");
    }
    return created;
  } catch (err) {
    if (err instanceof SlotCollisionError) throw err;
    if (isSqliteUniqueConstraint(err)) {
      throw new SlotCollisionError(input.calendarioId, input.inicio);
    }
    throw err;
  }
}

export function getAppointment(store: Store, id: number): Appointment | null {
  const row = store.db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM appointments WHERE id = ?`)
    .get(id) as AppointmentDbRow | undefined;
  return row ? toAppointment(row) : null;
}

/**
 * Agendamentos ainda válidos do paciente: status CONFIRMADO e início no futuro.
 * A comparação de tempo é feita em Luxon (as datas ficam gravadas com offset),
 * nunca em SQL — o formato do SQLite não é comparável com ISO com fuso.
 */
export function listActiveAppointments(
  store: Store,
  waId: string,
  agora: DateTime,
): Appointment[] {
  const rows = store.db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM appointments
        WHERE wa_id = ? AND status = 'CONFIRMADO'
        ORDER BY inicio ASC`,
    )
    .all(waId) as AppointmentDbRow[];

  return rows
    .map(toAppointment)
    .filter((appointment) => {
      const inicio = DateTime.fromISO(appointment.inicio, {
        zone: agora.zone,
      });
      return inicio.isValid && inicio > agora;
    });
}

export function markAppointmentCancelled(
  store: Store,
  id: number,
  motivo: string,
): void {
  store.db
    .prepare(
      `UPDATE appointments
          SET status = 'CANCELADO',
              cancelado_em = datetime('now'),
              atualizado_em = datetime('now'),
              motivo_cancelamento = ?
        WHERE id = ? AND status = 'CONFIRMADO'`,
    )
    .run(motivo, id);
}

export function markAppointmentRescheduled(store: Store, id: number): void {
  store.db
    .prepare(
      `UPDATE appointments
          SET status = 'REMARCADO',
              atualizado_em = datetime('now')
        WHERE id = ? AND status = 'CONFIRMADO'`,
    )
    .run(id);
}

/**
 * Exclusão LGPD: apaga o que é histórico morto (cancelado, remarcado ou já
 * passado) e preserva o compromisso futuro — exatamente o que a mensagem de
 * confirmação promete ao paciente. O que sobra é expurgado por idade depois.
 */
export function deletePastAppointments(
  store: Store,
  waId: string,
  agora: DateTime,
): number {
  const rows = store.db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM appointments WHERE wa_id = ?`)
    .all(waId) as AppointmentDbRow[];

  const removiveis = rows.map(toAppointment).filter((appointment) => {
    if (appointment.status !== "CONFIRMADO") return true;
    const inicio = DateTime.fromISO(appointment.inicio, { zone: agora.zone });
    return !inicio.isValid || inicio <= agora;
  });

  const del = store.db.prepare(`DELETE FROM appointments WHERE id = ?`);
  const run = store.db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
  });
  run(removiveis.map((a) => a.id));

  return removiveis.length;
}

/** Expurgo por idade: remove agendamentos cujo início é anterior ao corte. */
export function purgeAppointmentsBefore(store: Store, corte: DateTime): number {
  const rows = store.db
    .prepare(`SELECT id, inicio FROM appointments`)
    .all() as Array<{ id: number; inicio: string }>;

  const velhos = rows.filter((row) => {
    const inicio = DateTime.fromISO(row.inicio, { zone: corte.zone });
    return inicio.isValid && inicio < corte;
  });

  const del = store.db.prepare(`DELETE FROM appointments WHERE id = ?`);
  const run = store.db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
  });
  run(velhos.map((r) => r.id));

  return velhos.length;
}
