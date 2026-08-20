import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/brain/agent.js";
import {
  DELETE_CONFIRMATION_MESSAGE,
  TEXTO_EXPURGADO,
  deleteUserData,
  detectDeleteRequest,
} from "../src/brain/privacy.js";
import { purgeOldConversations } from "../src/jobs/purge.js";
import type { CalendarClient } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import { maskPhone } from "../src/channel/mask.js";
import {
  computeWeeklyReport,
  formatWeeklyReportText,
} from "../src/reports/weekly.js";
import {
  insertDemanda,
  listDemandasAbertas,
  logEvent,
  openStore,
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "privacy-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
  return { store, config };
}

function noopCalendar(): CalendarClient {
  return {
    name: "google_calendar",
    ready: true,
    async queryBusy() {
      return new Map();
    },
    async createEvent() {
      return { id: "evt-test" };
    },
    async deleteEvent() {
      /* nada a fazer no fake */
    },
  };
}

function seedInbound(store: Store, waId: string, texto: string): void {
  const conversationId = upsertConversation(store, waId);
  tryInsertMessage(store, {
    conversationId,
    direcao: "in",
    texto,
    waMessageId: `wamid.${Math.random().toString(16).slice(2)}`,
  });
}

function eventsOfType(store: Store, tipo: string): Array<Record<string, unknown>> {
  return store.db
    .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
    .all(tipo)
    .map((r) => JSON.parse((r as { payload_json: string }).payload_json));
}

function countRows(store: Store, waId: string): { conversas: number; mensagens: number } {
  const conversas = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE wa_id = ?`)
      .get(waId) as { n: number }
  ).n;
  const mensagens = (
    store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.wa_id = ?`,
      )
      .get(waId) as { n: number }
  ).n;
  return { conversas, mensagens };
}

function countByTipo(store: Store): Record<string, number> {
  const rows = store.db
    .prepare(`SELECT tipo, COUNT(*) AS n FROM events GROUP BY tipo`)
    .all() as Array<{ tipo: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.tipo, r.n]));
}

// ---------------------------------------------------------------------------

describe("detectDeleteRequest", () => {
  it("reconhece variações com acento, maiúscula e frase ao redor", () => {
    const positivos = [
      "excluir meus dados",
      "EXCLUIR MEUS DADOS",
      "Por favor, apague meus dados",
      "quero deletar meus dados agora",
      "gostaria de remover meus dados do sistema",
      "quero meus dados excluídos",
      "Exclua meus dados pessoais, obrigado",
      "apagar minhas informações",
    ];
    for (const texto of positivos) {
      expect(detectDeleteRequest(texto), texto).toBe(true);
    }
  });

  it("não dispara em conversa normal", () => {
    const negativos = [
      "quero marcar uma limpeza",
      "quais dados vocês guardam?",
      "preciso excluir o horário que marquei",
      "quanto custa?",
      "",
    ];
    for (const texto of negativos) {
      expect(detectDeleteRequest(texto), texto).toBe(false);
    }
  });
});

describe("deleteUserData", () => {
  it("apaga mensagens antes da conversa e não deixa órfão", () => {
    const { store } = setup();
    seedInbound(store, "5511900000001", "oi");
    seedInbound(store, "5511900000001", "quero marcar limpeza");
    seedInbound(store, "5511900000002", "outra pessoa");

    const result = deleteUserData(store, "5511900000001");

    expect(result.conversaRemovida).toBe(true);
    expect(result.mensagens).toBe(2);
    expect(countRows(store, "5511900000001")).toEqual({ conversas: 0, mensagens: 0 });
    // Não pode tocar em ninguém mais.
    expect(countRows(store, "5511900000002").conversas).toBe(1);

    const orfas = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
            WHERE conversation_id NOT IN (SELECT id FROM conversations)`,
        )
        .get() as { n: number }
    ).n;
    expect(orfas).toBe(0);
  });

  it("é idempotente para wa_id inexistente", () => {
    const { store } = setup();
    expect(deleteUserData(store, "5511900000009")).toEqual({
      mensagens: 0,
      conversaRemovida: false,
      agendamentosRemovidos: 0,
      demandasRemovidas: 0,
      eventosExpurgados: 0,
    });
  });
});

describe("exclusão pelo agente", () => {
  function makeAgent(store: Store, config: ReturnType<typeof ConfigService.load>) {
    return createAgent({
      store,
      claude: createScriptedClaude([
        () => textResult("nunca deveria ser chamado neste teste"),
      ]),
      calendar: noopCalendar(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
    });
  }

  it("funciona com a conversa EM_HUMANO mutada — precede o silêncio de 12h", async () => {
    const { store, config } = setup();
    const waId = "5511900000010";
    seedInbound(store, waId, "quero falar com atendente");
    setConversationState(store, waId, "EM_HUMANO", {
      motivoHandoff: "gatilho_explicito",
      emHumanoDesde: DateTime.now().toISO() ?? "",
    });

    const agent = makeAgent(store, config);
    const turn = await agent.handleUserMessage(waId, "excluir meus dados");

    expect(turn.muted).toBe(false);
    expect(turn.handoff).toBe(false);
    expect(turn.reply).toBe(DELETE_CONFIRMATION_MESSAGE);
    expect(countRows(store, waId)).toEqual({ conversas: 0, mensagens: 0 });
  });

  it("avisa que o agendamento permanece na agenda da clínica", async () => {
    const { store, config } = setup();
    const waId = "5511900000011";
    seedInbound(store, waId, "oi");

    const agent = makeAgent(store, config);
    const turn = await agent.handleUserMessage(waId, "apague meus dados");

    expect(turn.reply).toMatch(/agenda da clínica/i);
  });

  it("o evento logado não contém telefone completo nem texto de mensagem", async () => {
    const { store, config } = setup();
    const waId = "5511987654321";
    seedInbound(store, waId, "meu nome é Fulano de Tal e tenho cárie");

    const agent = makeAgent(store, config);
    await agent.handleUserMessage(waId, "excluir meus dados");

    const eventos = eventsOfType(store, "lgpd.exclusao_solicitada");
    expect(eventos).toHaveLength(1);

    const serialized = JSON.stringify(eventos[0]);
    expect(serialized).not.toContain(waId);
    expect(serialized).not.toContain("87654321");
    expect(serialized).not.toContain("Fulano");
    expect(serialized).not.toContain("cárie");
    expect(eventos[0]?.mensagens_removidas).toBe(1);
    expect(typeof eventos[0]?.eventos_expurgados).toBe("number");
  });
});

describe("expurgo de texto em events a pedido do titular", () => {
  function makeAgent(store: Store, config: ReturnType<typeof ConfigService.load>) {
    return createAgent({
      store,
      claude: createScriptedClaude([
        () => textResult("nunca deveria ser chamado neste teste"),
      ]),
      calendar: noopCalendar(),
      notifyHuman: async () => undefined,
      getConfig: () => config,
      now: () => new Date("2026-07-28T12:00:00-03:00"),
    });
  }

  it("após exclusão nenhum evento guarda a frase do paciente e a contagem por tipo permanece", async () => {
    const { store, config } = setup();
    const waId = "5511900000040";
    const frase = "estou com muita dor no siso, sangrando";
    seedInbound(store, waId, frase);

    const agent = makeAgent(store, config);
    const handoff = await agent.handleUserMessage(waId, frase);
    expect(handoff.handoff).toBe(true);

    const payloadsAntes = store.db
      .prepare(`SELECT payload_json FROM events`)
      .all() as Array<{ payload_json: string }>;
    expect(payloadsAntes.some((r) => r.payload_json.includes("sangrando"))).toBe(
      true,
    );
    const contagemAntes = countByTipo(store);

    const exclusao = await agent.handleUserMessage(waId, "excluir meus dados");
    expect(exclusao.reply).toBe(DELETE_CONFIRMATION_MESSAGE);

    const payloads = store.db
      .prepare(`SELECT payload_json FROM events`)
      .all() as Array<{ payload_json: string }>;
    for (const row of payloads) {
      expect(row.payload_json).not.toContain(frase);
      expect(row.payload_json).not.toContain("sangrando");
      expect(row.payload_json).not.toContain("muita dor no siso");
    }

    const transferido = eventsOfType(store, "handoff.transferido")[0];
    expect(transferido?.user_text).toBe(TEXTO_EXPURGADO);
    expect(transferido?.intencao).toBe(TEXTO_EXPURGADO);
    expect(transferido?.motivo).toBe("urgencia_clinica");

    const contagemDepois = countByTipo(store);
    for (const [tipo, n] of Object.entries(contagemAntes)) {
      expect(contagemDepois[tipo], tipo).toBe(n);
    }
    expect(contagemDepois["lgpd.exclusao_solicitada"]).toBe(1);

    const exclusaoEvento = eventsOfType(store, "lgpd.exclusao_solicitada")[0];
    expect(exclusaoEvento?.eventos_expurgados).toBeGreaterThan(0);
    expect(JSON.stringify(exclusaoEvento)).not.toContain(frase);
    expect(JSON.stringify(exclusaoEvento)).not.toContain(waId);
  });

  it("não altera events de outro wa_id", () => {
    const { store } = setup();
    const titular = "5511900000041";
    const outro = "5511900000042";
    logEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone(titular),
      motivo: "urgencia_clinica",
      user_text: "frase do titular sobre cárie",
      intencao: "frase do titular sobre cárie",
    });
    logEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone(outro),
      motivo: "urgencia_clinica",
      user_text: "frase do vizinho sobre implante",
      intencao: "frase do vizinho sobre implante",
    });

    const result = deleteUserData(store, titular);
    expect(result.eventosExpurgados).toBe(1);

    const payloads = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .all("handoff.transferido") as Array<{ payload_json: string }>;
    const doTitular = payloads.find((r) =>
      r.payload_json.includes(maskPhone(titular)),
    );
    const doOutro = payloads.find((r) =>
      r.payload_json.includes(maskPhone(outro)),
    );
    expect(doTitular?.payload_json).toContain(TEXTO_EXPURGADO);
    expect(doTitular?.payload_json).not.toContain("cárie");
    expect(doOutro?.payload_json).toContain("frase do vizinho sobre implante");
    expect(doOutro?.payload_json).not.toContain(TEXTO_EXPURGADO);
  });

  it("relatório semanal continua gerando e conta o handoff após o expurgo", () => {
    const { store } = setup();
    const waId = "5511900000043";
    const criadoEm = "2026-07-28T15:00:00.000Z";
    store.db
      .prepare(
        `INSERT INTO events (tipo, payload_json, criado_em) VALUES (?, ?, ?)`,
      )
      .run(
        "handoff.transferido",
        JSON.stringify({
          wa_id_masked: maskPhone(waId),
          motivo: "urgencia_clinica",
          user_text: "estou com muita dor no siso, sangrando",
          intencao: "estou com muita dor no siso, sangrando",
          notificacao_ok: true,
        }),
        criadoEm,
      );

    deleteUserData(store, waId);

    const data = computeWeeklyReport(
      store,
      DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ }),
    );
    expect(data.handoffMotivos.some((m) => m.motivo === "urgencia_clinica")).toBe(
      true,
    );
    const texto = formatWeeklyReportText(data);
    expect(texto.length).toBeGreaterThan(0);
    expect(texto).not.toContain("sangrando");
    expect(texto).not.toContain("muita dor no siso");
  });
});

describe("purgeOldConversations", () => {
  function seedAged(
    store: Store,
    waId: string,
    diasAtras: number,
    options?: { estado?: "LIVRE" | "EM_HUMANO"; emHumanoHaHoras?: number },
  ): void {
    seedInbound(store, waId, "mensagem qualquer");

    if (options?.estado === "EM_HUMANO") {
      setConversationState(store, waId, "EM_HUMANO", {
        emHumanoDesde:
          DateTime.now()
            .minus({ hours: options.emHumanoHaHoras ?? 1 })
            .toISO() ?? "",
      });
    }

    store.db
      .prepare(
        `UPDATE conversations
            SET atualizado_em = datetime('now', ?)
          WHERE wa_id = ?`,
      )
      .run(`-${diasAtras} days`, waId);
  }

  it("remove a conversa velha, preserva a recente e preserva EM_HUMANO ativo", () => {
    const { store } = setup();
    seedAged(store, "5511900000021", 200);
    seedAged(store, "5511900000022", 10);
    seedAged(store, "5511900000023", 200, {
      estado: "EM_HUMANO",
      emHumanoHaHoras: 2,
    });

    const result = purgeOldConversations(store, 180, { silencioEmHumanoHoras: 12 });

    expect(result.conversas).toBe(1);
    expect(result.mensagens).toBe(1);
    expect(result.preservadasEmHumano).toBe(1);

    expect(countRows(store, "5511900000021").conversas).toBe(0);
    expect(countRows(store, "5511900000022").conversas).toBe(1);
    expect(countRows(store, "5511900000023").conversas).toBe(1);
  });

  it("apaga EM_HUMANO cuja janela de silêncio já passou", () => {
    const { store } = setup();
    seedAged(store, "5511900000024", 200, {
      estado: "EM_HUMANO",
      emHumanoHaHoras: 48,
    });

    const result = purgeOldConversations(store, 180, { silencioEmHumanoHoras: 12 });

    expect(result.conversas).toBe(1);
    expect(result.preservadasEmHumano).toBe(0);
    expect(countRows(store, "5511900000024").conversas).toBe(0);
  });

  it("não deixa mensagens órfãs e grava o evento sem dado pessoal", () => {
    const { store } = setup();
    seedAged(store, "5511900000025", 365);

    purgeOldConversations(store, 180);

    const orfas = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
            WHERE conversation_id NOT IN (SELECT id FROM conversations)`,
        )
        .get() as { n: number }
    ).n;
    expect(orfas).toBe(0);

    const eventos = eventsOfType(store, "lgpd.expurgo");
    expect(eventos).toHaveLength(1);
    expect(JSON.stringify(eventos[0])).not.toContain("5511900000025");
  });

  it("não apaga nada quando não há conversa fora do prazo", () => {
    const { store } = setup();
    seedAged(store, "5511900000026", 5);

    const result = purgeOldConversations(store, 180);

    expect(result).toEqual({
      conversas: 0,
      mensagens: 0,
      preservadasEmHumano: 0,
      agendamentos: 0,
      eventos: 0,
      demandas: 0,
    });
    expect(eventsOfType(store, "lgpd.expurgo")).toHaveLength(0);
  });

  it("aceita relógio injetado — aritmética por Luxon, não Date nativo", () => {
    const { store } = setup();
    seedAged(store, "5511900000027", 30);

    // "Agora" 200 dias no futuro: a conversa de 30 dias atrás passa a ter 230.
    const futuro = DateTime.now().plus({ days: 200 });
    const result = purgeOldConversations(store, 180, { now: futuro });

    expect(result.conversas).toBe(1);
  });
});

describe("retenção do log de auditoria e da fila de retorno", () => {
  it("expurga events antigos — a pergunta do paciente não fica para sempre", () => {
    const { store } = setup();
    const agora = DateTime.fromISO("2026-07-27T12:00:00", { zone: TZ });

    const velho = agora.minus({ days: 200 }).toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
    const recente = agora.minus({ days: 10 }).toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

    store.db
      .prepare(`INSERT INTO events (tipo, payload_json, criado_em) VALUES (?, ?, ?)`)
      .run(
        "handoff.transferido",
        JSON.stringify({ user_text: "estou com dor forte no siso" }),
        velho,
      );
    store.db
      .prepare(`INSERT INTO events (tipo, payload_json, criado_em) VALUES (?, ?, ?)`)
      .run("handoff.transferido", JSON.stringify({ user_text: "recente" }), recente);

    const result = purgeOldConversations(store, 180, { now: agora, timezone: TZ });

    expect(result.eventos).toBe(1);
    const restantes = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .all("handoff.transferido") as Array<{ payload_json: string }>;
    expect(restantes).toHaveLength(1);
    expect(restantes[0]!.payload_json).toContain("recente");
    expect(restantes[0]!.payload_json).not.toContain("siso");
  });

  it("expurga demandas antigas e preserva as recentes", () => {
    const { store } = setup();
    const agora = DateTime.fromISO("2026-07-27T12:00:00", { zone: TZ });

    insertDemanda(store, { waId: "5511900000021", servicoId: "limpeza" });
    insertDemanda(store, { waId: "5511900000022", servicoId: "clareamento" });
    store.db
      .prepare(`UPDATE demandas SET criado_em = ? WHERE wa_id = ?`)
      .run(
        agora.minus({ days: 200 }).toUTC().toFormat("yyyy-LL-dd HH:mm:ss"),
        "5511900000021",
      );

    const result = purgeOldConversations(store, 180, { now: agora, timezone: TZ });

    expect(result.demandas).toBe(1);
    const fila = listDemandasAbertas(store);
    expect(fila).toHaveLength(1);
    expect(fila[0]?.waId).toBe("5511900000022");
  });

  it("exclusão a pedido tira o telefone da fila de retorno", () => {
    const { store } = setup();
    const waId = "5511900000030";
    insertDemanda(store, { waId, servicoId: "limpeza", janelaDesejada: "sexta" });
    insertDemanda(store, { waId: "5511900000031", servicoId: "limpeza" });

    const result = deleteUserData(store, waId);

    expect(result.demandasRemovidas).toBe(1);
    expect(listDemandasAbertas(store).map((d) => d.waId)).toEqual([
      "5511900000031",
    ]);
  });
});
