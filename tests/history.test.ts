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

  it("após 6h de inatividade começa do zero (só contato atual)", () => {
    const store = tempStore();
    const waId = "551100000011";
    const conversationId = upsertConversation(store, waId);
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();

    tryInsertMessage(store, {
      conversationId,
      direcao: "in",
      texto: "mensagem antiga",
      waMessageId: "old-1",
      timestamp: sevenHoursAgo,
    });
    tryInsertMessage(store, {
      conversationId,
      direcao: "out",
      texto: "resposta antiga",
      waMessageId: "old-2",
      timestamp: sevenHoursAgo,
    });
    tryInsertMessage(store, {
      conversationId,
      direcao: "in",
      texto: "voltei agora",
      waMessageId: "new-1",
      timestamp: new Date().toISOString(),
    });

    const window = getConversationWindow(store, waId, { now: new Date() });
    expect(window).toHaveLength(1);
    expect(window[0]?.texto).toBe("voltei agora");
    store.close();
  });
});
