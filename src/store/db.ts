import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'novo',
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
