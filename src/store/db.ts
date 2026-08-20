import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'LIVRE',
  estado_payload TEXT NOT NULL DEFAULT '{}',
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direcao TEXT NOT NULL CHECK (direcao IN ('in', 'out')),
  texto TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  wa_message_id TEXT UNIQUE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_tipo ON events(tipo);
`;

/**
 * Agendamentos confirmados. Espelho local do que existe no Google Calendar:
 * sem ele o bot não sabe que o paciente TEM horário marcado e não consegue
 * cancelar nem remarcar sem passar por um humano.
 *
 * Sem FOREIGN KEY para conversations de propósito — o compromisso sobrevive à
 * exclusão da conversa (LGPD), como já é prometido ao paciente.
 */
const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  servico_id TEXT NOT NULL,
  servico_nome TEXT NOT NULL,
  profissional_id TEXT NOT NULL,
  profissional_nome TEXT NOT NULL,
  calendario_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMADO'
    CHECK (status IN ('CONFIRMADO', 'CANCELADO', 'REMARCADO')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  cancelado_em TEXT,
  motivo_cancelamento TEXT,
  remarcado_de_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_appointments_wa_id ON appointments(wa_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status, inicio);
`;

/**
 * Demanda não atendida — quem pediu horário que não existia.
 *
 * Isto é lista de retorno comercial, não log: quando abrir vaga, alguém liga.
 * Por isso guarda telefone completo, e por isso mora aqui e não em `events` —
 * dado de contato precisa de finalidade declarada e de expurgo próprio.
 */
const MIGRATION_V3 = `
CREATE TABLE IF NOT EXISTS demandas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  servico_id TEXT NOT NULL,
  janela_desejada TEXT,
  status TEXT NOT NULL DEFAULT 'ABERTA'
    CHECK (status IN ('ABERTA', 'CONTATADA', 'RESOLVIDA')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  contatado_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_demandas_wa_id ON demandas(wa_id);
CREATE INDEX IF NOT EXISTS idx_demandas_status ON demandas(status, criado_em);
CREATE INDEX IF NOT EXISTS idx_events_criado_em ON events(criado_em);
`;

function migrateConversations(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  if (!names.has("estado_payload")) {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN estado_payload TEXT NOT NULL DEFAULT '{}'`,
    );
  }

  if (!names.has("aviso_lgpd_em")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN aviso_lgpd_em TEXT`);
  }

  db.exec(
    `UPDATE conversations
     SET estado = 'LIVRE'
     WHERE estado IN ('novo', 'NEW', '') OR estado IS NULL`,
  );
}

export type Store = {
  db: Database.Database;
  close: () => void;
};

export function openStore(sqlitePath: string): Store {
  const absolutePath = resolve(sqlitePath);
  mkdirSync(dirname(absolutePath), { recursive: true });

  const db = new Database(absolutePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(MIGRATION_V1);
  db.exec(MIGRATION_V2);
  db.exec(MIGRATION_V3);
  migrateConversations(db);

  return {
    db,
    close: () => db.close(),
  };
}

export function logEvent(
  store: Store,
  tipo: string,
  payload: Record<string, unknown>,
): void {
  store.db
    .prepare("INSERT INTO events (tipo, payload_json) VALUES (?, ?)")
    .run(tipo, JSON.stringify(payload));
}

/**
 * Expurgo do log de auditoria. `events` guarda a pergunta do paciente
 * (handoff.transferido, resposta_sem_fonte) — sem isto, a retenção prometida
 * no aviso de privacidade não vale para o dado mais sensível que existe aqui.
 *
 * `criado_em` é gravado por datetime('now'), ou seja UTC "YYYY-MM-DD HH:MM:SS".
 */
export function purgeEventsBefore(store: Store, corteSql: string): number {
  return store.db
    .prepare(`DELETE FROM events WHERE criado_em < ?`)
    .run(corteSql).changes;
}

/** Contagem de eventos de um tipo desde um instante — usado pelo /health. */
export function countEventsSince(
  store: Store,
  tipos: string[],
  sinceSql: string,
): number {
  if (tipos.length === 0) return 0;
  const placeholders = tipos.map(() => "?").join(", ");
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE tipo IN (${placeholders}) AND criado_em >= ?`,
    )
    .get(...tipos, sinceSql) as { n: number };
  return row.n;
}
