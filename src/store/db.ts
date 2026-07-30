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
