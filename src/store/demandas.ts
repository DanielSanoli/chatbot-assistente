import { DateTime } from "luxon";
import type { Store } from "./db.js";

export const DEMANDA_STATUSES = ["ABERTA", "CONTATADA", "RESOLVIDA"] as const;

export type DemandaStatus = (typeof DEMANDA_STATUSES)[number];

export type Demanda = {
  id: number;
  waId: string;
  servicoId: string;
  janelaDesejada: string | null;
  status: DemandaStatus;
  criadoEm: string;
  contatadoEm: string | null;
};

type DemandaDbRow = {
  id: number;
  wa_id: string;
  servico_id: string;
  janela_desejada: string | null;
  status: string;
  criado_em: string;
  contatado_em: string | null;
};

function toDemanda(row: DemandaDbRow): Demanda {
  return {
    id: row.id,
    waId: row.wa_id,
    servicoId: row.servico_id,
    janelaDesejada: row.janela_desejada,
    status: (DEMANDA_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as DemandaStatus)
      : "ABERTA",
    criadoEm: row.criado_em,
    contatadoEm: row.contatado_em,
  };
}

export function insertDemanda(
  store: Store,
  input: { waId: string; servicoId: string; janelaDesejada?: string },
): Demanda {
  const result = store.db
    .prepare(
      `INSERT INTO demandas (wa_id, servico_id, janela_desejada)
       VALUES (?, ?, ?)`,
    )
    .run(input.waId, input.servicoId, input.janelaDesejada ?? null);

  const row = store.db
    .prepare(
      `SELECT id, wa_id, servico_id, janela_desejada, status, criado_em, contatado_em
         FROM demandas WHERE id = ?`,
    )
    .get(Number(result.lastInsertRowid)) as DemandaDbRow | undefined;

  if (!row) {
    throw new Error("Falha ao gravar demanda não atendida");
  }
  return toDemanda(row);
}

/** Fila de retorno: quem ainda não foi chamado de volta, mais antigo primeiro. */
export function listDemandasAbertas(store: Store, servicoId?: string): Demanda[] {
  const rows = servicoId
    ? (store.db
        .prepare(
          `SELECT id, wa_id, servico_id, janela_desejada, status, criado_em, contatado_em
             FROM demandas
            WHERE status = 'ABERTA' AND servico_id = ?
            ORDER BY criado_em ASC`,
        )
        .all(servicoId) as DemandaDbRow[])
    : (store.db
        .prepare(
          `SELECT id, wa_id, servico_id, janela_desejada, status, criado_em, contatado_em
             FROM demandas
            WHERE status = 'ABERTA'
            ORDER BY criado_em ASC`,
        )
        .all() as DemandaDbRow[]);

  return rows.map(toDemanda);
}

export function marcarDemandaContatada(store: Store, id: number): void {
  store.db
    .prepare(
      `UPDATE demandas
          SET status = 'CONTATADA', contatado_em = datetime('now')
        WHERE id = ? AND status = 'ABERTA'`,
    )
    .run(id);
}

/** Exclusão LGPD: a fila de retorno é dado de contato do titular. */
export function deleteDemandasByWaId(store: Store, waId: string): number {
  return store.db.prepare(`DELETE FROM demandas WHERE wa_id = ?`).run(waId)
    .changes;
}

/** Expurgo por idade do registro. `criado_em` é UTC no formato do SQLite. */
export function purgeDemandasBefore(store: Store, corte: DateTime): number {
  const corteSql = corte.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
  return store.db
    .prepare(`DELETE FROM demandas WHERE criado_em < ?`)
    .run(corteSql).changes;
}
