import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getConversationWindow,
  openStore,
  tryInsertMessage,
  upsertConversation,
  type Store,
} from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  dirs.push(dir);
  return openStore(join(dir, "t.db"));
}

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function timestampOf(store: Store, waMessageId: string): string {
  const row = store.db
    .prepare(`SELECT timestamp FROM messages WHERE wa_message_id = ?`)
    .get(waMessageId) as { timestamp: string } | undefined;
  if (!row) throw new Error(`mensagem ${waMessageId} não encontrada`);
  return row.timestamp;
}

/**
 * Conversa antiga + resposta do bot gravada pelo default do banco (como o
 * sendText em produção) + paciente que volta `hoursAgo` horas depois.
 */
function seedReturnAfterHours(
  store: Store,
  waId: string,
  hoursAgo: number,
  now: Date,
): void {
  const conversationId = upsertConversation(store, waId);
  const pastIso = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();

  tryInsertMessage(store, {
    conversationId,
    direcao: "in",
    texto: "mensagem antiga",
    waMessageId: `${waId}-old-in`,
    timestamp: pastIso,
  });
  tryInsertMessage(store, {
    conversationId,
    direcao: "out",
    texto: "resposta antiga",
    waMessageId: `${waId}-old-out`,
  });
  expect(timestampOf(store, `${waId}-old-out`)).toMatch(ISO_Z);
  store.db
    .prepare(`UPDATE messages SET timestamp = ? WHERE wa_message_id = ?`)
    .run(pastIso, `${waId}-old-out`);

  tryInsertMessage(store, {
    conversationId,
    direcao: "in",
    texto: "voltei agora",
    waMessageId: `${waId}-new-in`,
    timestamp: now.toISOString(),
  });
}

describe("conversation history window", () => {
  it("mantém no máximo 20 mensagens", () => {
    const store = tempStore();
    const waId = "551100000010";
    const conversationId = upsertConversation(store, waId);

    for (let i = 0; i < 25; i++) {
      tryInsertMessage(store, {
        conversationId,
        direcao: i % 2 === 0 ? "in" : "out",
        texto: `msg-${i}`,
        waMessageId: `id-${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60_000).toISOString(),
      });
    }

    const window = getConversationWindow(store, waId);
    expect(window).toHaveLength(20);
    expect(window[0]?.texto).toBe("msg-5");
    expect(window[19]?.texto).toBe("msg-24");
    store.close();
  });

  it("mensagem out sem timestamp usa ISO com Z (default do banco)", () => {
    const store = tempStore();
    const conversationId = upsertConversation(store, "551100000012");
    tryInsertMessage(store, {
      conversationId,
      direcao: "out",
      texto: "resposta",
      waMessageId: "out-default",
    });
    expect(timestampOf(store, "out-default")).toMatch(ISO_Z);
    store.close();
  });

  it("após 6h de inatividade começa do zero (só contato atual); out usa default do banco", () => {
    const store = tempStore();
    const waId = "551100000011";
    const now = new Date();
    seedReturnAfterHours(store, waId, 7, now);

    const window = getConversationWindow(store, waId, { now });
    expect(window).toHaveLength(1);
    expect(window[0]?.texto).toBe("voltei agora");
    store.close();
  });

  it("8h de inatividade real zera a sessão; 5h mantém o contexto", () => {
    const store = tempStore();
    const now = new Date("2026-08-20T21:00:00.000Z");

    seedReturnAfterHours(store, "551100000013", 8, now);
    const limpa = getConversationWindow(store, "551100000013", { now });
    expect(limpa).toHaveLength(1);
    expect(limpa[0]?.texto).toBe("voltei agora");

    seedReturnAfterHours(store, "551100000014", 5, now);
    const continua = getConversationWindow(store, "551100000014", { now });
    expect(continua).toHaveLength(3);
    expect(continua.map((m) => m.texto)).toEqual([
      "mensagem antiga",
      "resposta antiga",
      "voltei agora",
    ]);
    store.close();
  });

  it("formato legado YYYY-MM-DD HH:MM:SS é UTC, não hora local", () => {
    const store = tempStore();
    const waId = "551100000015";
    const conversationId = upsertConversation(store, waId);
    // 8h reais em UTC. Em America/Sao_Paulo, Date.parse sem Z leria 13:00
    // como local (= 16:00 UTC) e o idle viraria 5h — a sessão antiga vazaria.
    const legado = "2026-08-20 13:00:00";
    const now = new Date("2026-08-20T21:00:00.000Z");

    tryInsertMessage(store, {
      conversationId,
      direcao: "in",
      texto: "mensagem antiga",
      waMessageId: "leg-in",
      timestamp: legado,
    });
    tryInsertMessage(store, {
      conversationId,
      direcao: "out",
      texto: "resposta antiga",
      waMessageId: "leg-out",
      timestamp: legado,
    });
    tryInsertMessage(store, {
      conversationId,
      direcao: "in",
      texto: "voltei agora",
      waMessageId: "leg-new",
      timestamp: now.toISOString(),
    });

    const window = getConversationWindow(store, waId, { now });
    expect(window).toHaveLength(1);
    expect(window[0]?.texto).toBe("voltei agora");
    store.close();
  });
});
