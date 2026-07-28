import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, logEvent } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("store migration", () => {
  it("cria tabelas conversations, messages e events", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatbot-db-"));
    dirs.push(dir);
    const store = openStore(join(dir, "test.db"));

    const tables = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversations', 'messages', 'events') ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      "conversations",
      "events",
      "messages",
    ]);

    logEvent(store, "test.event", { ok: true });
    const row = store.db
      .prepare("SELECT tipo, payload_json FROM events LIMIT 1")
      .get() as { tipo: string; payload_json: string };

    expect(row.tipo).toBe("test.event");
    expect(JSON.parse(row.payload_json)).toEqual({ ok: true });

    store.close();
  });
});
