import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/brain/agent.js";
import { marcarAvisoLgpdEntregue } from "../src/brain/privacy.js";
import type { CalendarClient } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import {
  getConversationWindow,
  marcarAvisoLgpdEnviado,
  openStore,
  precisaEnviarAvisoLgpd,
  setConversationState,
  tryInsertMessage,
  upsertConversation,
  type Store,
} from "../src/store/index.js";
import { createScriptedClaude, textResult } from "./helpers/claudeMock.js";

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

const TZ = "America/Sao_Paulo";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  ConfigService.reset();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lgpd-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
  return { store, config };
}

function calendarOk(): CalendarClient {
  return {
    name: "google_calendar",
    ready: true,
    async queryBusy() {
      return new Map();
    },
    async createEvent() {
      return { id: "evt" };
    },
    async deleteEvent() {
      /* nada a fazer no fake */
    },
  };
}

function seedInbound(store: Store, waId: string, text: string, ts?: string): void {
  const conversationId = upsertConversation(store, waId);
  tryInsertMessage(store, {
    conversationId,
    direcao: "in",
    texto: text,
    waMessageId: `wamid.${Math.random().toString(16).slice(2)}`,
    timestamp: ts,
  });
}

function eventsOfType(store: Store, tipo: string): unknown[] {
  return store.db
    .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
    .all(tipo)
    .map((row) => JSON.parse((row as { payload_json: string }).payload_json));
}

describe("aviso LGPD", () => {
  it("sai uma única vez para o mesmo wa_id mesmo após limpeza da janela de 6h", async () => {
    const { store, config } = setup();
    const waId = "5511888000201";
    const aviso = config.privacidade.aviso_primeira_mensagem;

    seedInbound(store, waId, "oi");
    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => textResult("Olá! Como posso ajudar?"),
        () => textResult("Claro, em que posso ajudar?"),
      ]),
    });

    const first = await agent.handleUserMessage(waId, "oi");
    expect(first.reply?.startsWith(aviso)).toBe(true);
    expect(first.reply).toContain("Olá! Como posso ajudar?");
    // O agente sinaliza; quem marca é o canal, depois do envio dar certo.
    expect(first.avisoLgpdPendente).toBe(true);
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(true);
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(0);

    marcarAvisoLgpdEntregue(store, waId);
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(false);
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(1);

    const conversationId = upsertConversation(store, waId);
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    store.db
      .prepare(`UPDATE messages SET timestamp = ? WHERE conversation_id = ?`)
      .run(sevenHoursAgo, conversationId);
    tryInsertMessage(store, {
      conversationId,
      direcao: "out",
      texto: first.reply ?? "out",
      waMessageId: "out-old",
      timestamp: sevenHoursAgo,
    });
    seedInbound(store, waId, "voltei depois de 7h");

    const window = getConversationWindow(store, waId, {
      now: new Date(),
      idleHours: 6,
    });
    expect(window.length).toBeLessThanOrEqual(1);
    expect(window.every((m) => m.texto !== "oi")).toBe(true);

    const second = await agent.handleUserMessage(waId, "voltei depois de 7h");
    expect(second.reply?.startsWith(aviso)).toBe(false);
    expect(second.avisoLgpdPendente).toBe(false);
    expect(second.reply).toContain("Claro, em que posso ajudar?");
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(1);
  });

  it("sai no caminho de urgência clínica", async () => {
    const { store, config } = setup();
    const waId = "5511888000202";
    const aviso = config.privacidade.aviso_primeira_mensagem;
    const claude = vi.fn();

    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
      claude: { createMessage: claude },
      now: () => new Date("2026-07-28T12:00:00-03:00"),
    });

    const turn = await agent.handleUserMessage(waId, "estou com muita dor");
    expect(turn.handoff).toBe(true);
    expect(turn.reply?.startsWith(aviso)).toBe(true);
    expect(turn.reply).toContain(config.handoff.mensagem);
    expect(claude).not.toHaveBeenCalled();
    expect(turn.avisoLgpdPendente).toBe(true);

    marcarAvisoLgpdEntregue(store, waId);
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(1);
  });

  it("envio que falha não consome o aviso — o paciente recebe no próximo turno", async () => {
    const { store, config } = setup();
    const waId = "5511888000205";
    const aviso = config.privacidade.aviso_primeira_mensagem;

    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => textResult("Olá!"),
        () => textResult("Olá de novo!"),
      ]),
    });

    // Turno 1: o aviso é montado, mas a Graph API falha — ninguém marca nada.
    const primeiro = await agent.handleUserMessage(waId, "oi");
    expect(primeiro.reply?.startsWith(aviso)).toBe(true);
    expect(primeiro.avisoLgpdPendente).toBe(true);
    // (sem marcarAvisoLgpdEntregue: simula o throw do sendText)

    // Turno 2: o aviso continua devendo, então sai de novo.
    const segundo = await agent.handleUserMessage(waId, "alguém aí?");
    expect(segundo.reply?.startsWith(aviso)).toBe(true);
    expect(segundo.avisoLgpdPendente).toBe(true);
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(0);
  });

  it("NÃO sai quando isMutedEmHumano é true", async () => {
    const { store, config } = setup();
    const waId = "5511888000203";
    const agora = DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ });
    const aviso = config.privacidade.aviso_primeira_mensagem;

    setConversationState(store, waId, "EM_HUMANO", {
      emHumanoDesde: agora.toISO() ?? undefined,
      motivoHandoff: "teste",
    });
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(true);

    const claude = vi.fn();
    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
      claude: { createMessage: claude },
      now: () => agora.plus({ hours: 1 }).toJSDate(),
    });

    const turn = await agent.handleUserMessage(waId, "oi de novo");
    expect(turn.muted).toBe(true);
    expect(turn.reply).toBeNull();
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(true);
    expect(eventsOfType(store, "lgpd.aviso_enviado")).toHaveLength(0);
    expect(claude).not.toHaveBeenCalled();
    expect(aviso.length).toBeGreaterThan(0);
  });

  it("marcador é durável independente do histórico de mensagens", () => {
    const { store } = setup();
    const waId = "5511888000204";
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(true);
    marcarAvisoLgpdEnviado(store, waId);
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(false);

    const conversationId = upsertConversation(store, waId);
    store.db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .run(conversationId);
    expect(precisaEnviarAvisoLgpd(store, waId)).toBe(false);
  });
});
