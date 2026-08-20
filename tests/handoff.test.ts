import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/brain/agent.js";
import { proporHorarios } from "../src/brain/booking.js";
import {
  detectExplicitHandoff,
  detectUrgency,
  isMutedEmHumano,
  transferToHuman,
} from "../src/brain/handoff.js";
import { executeTool } from "../src/brain/tools.js";
import type { CalendarClient } from "../src/calendar/google.js";
import { CalendarUnavailable } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import {
  getConversation,
  listDemandasAbertas,
  openStore,
  setConversationState,
  type Store,
} from "../src/store/index.js";
import { maskPhone } from "../src/channel/mask.js";
import { createScriptedClaude, toolUseResult } from "./helpers/claudeMock.js";

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "5511988887777",
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
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
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

function calendarDown(): CalendarClient {
  return {
    name: "google_calendar",
    ready: true,
    async queryBusy() {
      throw new CalendarUnavailable("Google fora do ar");
    },
    async createEvent() {
      throw new CalendarUnavailable("Google fora do ar");
    },
    async deleteEvent() {
      throw new CalendarUnavailable("Google fora do ar");
    },
  };
}

function eventsOfType(store: Store, tipo: string) {
  return store.db
    .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
    .all(tipo)
    .map((r) => JSON.parse((r as { payload_json: string }).payload_json));
}

describe("detecção", () => {
  it("detecta urgência clínica", () => {
    expect(detectUrgency("estou com muita dor")).toBe(true);
    expect(detectUrgency("sangramento na gengiva")).toBe(true);
    expect(detectUrgency("inchaço no rosto")).toBe(true);
    expect(detectUrgency("rosto inchado")).toBe(true);
    expect(detectUrgency("quero limpeza")).toBe(false);
  });

  it("detecta gatilho explícito", () => {
    const { config } = setup();
    expect(
      detectExplicitHandoff("quero falar com atendente", config.handoff.gatilhos_explicitos),
    ).toBeTruthy();
    expect(
      detectExplicitHandoff("quanto custa limpeza", config.handoff.gatilhos_explicitos),
    ).toBeNull();
  });
});

describe("quatro gatilhos de handoff", () => {
  it("(a) gatilho explícito transfere e envia resumo ao humano", async () => {
    const { store, config } = setup();
    const waId = "551100000101";
    const humanMsgs: Array<{ to: string; text: string }> = [];

    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async (to, text) => {
        humanMsgs.push({ to, text });
      },
      getConfig: () => config,
      claude: createScriptedClaude([
        () => {
          throw new Error("não deveria chegar no Claude");
        },
      ]),
      now: () => new Date("2026-07-28T12:00:00-03:00"),
    });

    const turn = await agent.handleUserMessage(waId, "quero falar com atendente");
    expect(turn.handoff).toBe(true);
    expect(turn.reply).toContain(config.handoff.mensagem);
    expect(turn.reply?.startsWith(config.privacidade.aviso_primeira_mensagem)).toBe(
      true,
    );
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");
    expect(humanMsgs).toHaveLength(1);
    expect(humanMsgs[0]?.to).toBe(config.handoff.numero_humano);
    expect(humanMsgs[0]?.text).toContain(waId);
    expect(humanMsgs[0]?.text).toMatch(/Motivo da transferência/i);
    expect(humanMsgs[0]?.text).toMatch(/falar com atendente/i);
  });

  it("(b) tema sempre humano classificado via ferramenta", async () => {
    const { store, config } = setup();
    const waId = "551100000102";
    const humanMsgs: string[] = [];

    const result = await executeTool(
      {
        store,
        config,
        calendar: calendarOk(),
        waId,
        userText: "quero reclamar do atendimento péssimo",
        agora: DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ }),
        notifyHuman: async (_to, text) => {
          humanMsgs.push(text);
        },
      },
      "acionar_handoff",
      { motivo: "reclamacao", intencao: "reclamar do atendimento" },
    );

    expect((result as { handoff: boolean }).handoff).toBe(true);
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");
    expect(humanMsgs[0]).toContain("reclamar");
    expect(humanMsgs[0]).toContain("reclamacao");
  });

  it("(c) duas falhas seguidas de entendimento no mesmo assunto", async () => {
    const { store, config } = setup();
    const waId = "551100000103";
    const humanMsgs: string[] = [];
    const notifyHuman = async (_to: string, text: string) => {
      humanMsgs.push(text);
    };
    const agora = DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ });

    const first = await executeTool(
      {
        store,
        config,
        calendar: calendarOk(),
        waId,
        agora,
        userText: "aquela coisa lá",
        notifyHuman,
      },
      "registrar_falha_entendimento",
      { assunto: "horario" },
    );
    expect((first as { deveTransferir: boolean }).deveTransferir).toBe(false);
    expect(humanMsgs).toHaveLength(0);

    const second = await executeTool(
      {
        store,
        config,
        calendar: calendarOk(),
        waId,
        agora,
        userText: "você não entendeu de novo",
        notifyHuman,
      },
      "registrar_falha_entendimento",
      { assunto: "horario" },
    );
    expect((second as { handoff: boolean }).handoff).toBe(true);
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");
    expect(humanMsgs).toHaveLength(1);
    expect(humanMsgs[0]).toContain("falha_entendimento");
  });

  it("(d) erro interno CalendarUnavailable transfere", async () => {
    const { store, config } = setup();
    const waId = "551100000104";
    const humanMsgs: string[] = [];

    const agent = createAgent({
      store,
      calendar: calendarDown(),
      notifyHuman: async (_to, text) => {
        humanMsgs.push(text);
      },
      getConfig: () => config,
      claude: createScriptedClaude([
        () => toolUseResult("propor_horarios", { servicoId: "limpeza" }),
      ]),
      now: () => new Date("2026-07-28T12:00:00-03:00"),
    });

    const turn = await agent.handleUserMessage(waId, "quero agendar limpeza");
    expect(turn.handoff).toBe(true);
    expect(turn.reply).toBeTruthy();
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");
    expect(humanMsgs[0]).toMatch(/CalendarUnavailable|erro_interno/i);
  });
});

describe("EM_HUMANO mute e urgência", () => {
  it("conversa EM_HUMANO ignora mensagens novas por 12h", async () => {
    const { store, config } = setup();
    const waId = "551100000105";
    const agora = DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ });

    setConversationState(store, waId, "EM_HUMANO", {
      emHumanoDesde: agora.toISO() ?? undefined,
      motivoHandoff: "teste",
    });

    expect(isMutedEmHumano(store, waId, config, agora.plus({ hours: 1 }))).toBe(
      true,
    );

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
    expect(claude).not.toHaveBeenCalled();
  });

  it('"estou com muita dor" transfere na hora sem propor horário', async () => {
    const { store, config } = setup();
    const waId = "551100000106";
    const humanMsgs: string[] = [];
    const claude = vi.fn();

    const agent = createAgent({
      store,
      calendar: calendarOk(),
      notifyHuman: async (_to, text) => {
        humanMsgs.push(text);
      },
      getConfig: () => config,
      claude: { createMessage: claude },
      now: () => new Date("2026-07-28T12:00:00-03:00"),
    });

    const turn = await agent.handleUserMessage(waId, "estou com muita dor");
    expect(turn.handoff).toBe(true);
    expect(turn.reply).toContain(config.handoff.mensagem);
    expect(turn.reply?.startsWith(config.privacidade.aviso_primeira_mensagem)).toBe(
      true,
    );
    expect(claude).not.toHaveBeenCalled();
    expect(humanMsgs[0]).toMatch(/urgencia_clinica|muita dor/i);
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");
  });
});

describe("demanda não atendida", () => {
  it("agenda cheia gera demanda_nao_atendida", async () => {
    const { store, config } = setup();
    const waId = "551100000107";
    const dia = DateTime.fromISO("2026-07-28", { zone: TZ });

    const calendar: CalendarClient = {
      name: "google_calendar",
      ready: true,
      async queryBusy({ timeMin, timeMax, calendarIds }) {
        const map = new Map();
        for (const id of calendarIds) {
          map.set(id, [
            {
              start: timeMin,
              end: timeMax,
              allDay: false,
            },
          ]);
        }
        return map;
      },
      async createEvent() {
        return { id: "x" };
      },
      async deleteEvent() {
        /* nada a fazer no fake */
      },
    };

    const result = await proporHorarios(
      {
        store,
        config,
        calendar,
        waId,
        agora: dia.minus({ days: 1 }).set({ hour: 8 }),
      },
      { servicoId: "limpeza", preferencia: "terça de manhã" },
    );

    expect(result.ok).toBe(false);
    expect(result.demanda_registrada).toBe(true);
    // O evento é log de auditoria: telefone mascarado, sem dado de contato.
    const demandas = eventsOfType(store, "demanda_nao_atendida");
    expect(demandas.length).toBeGreaterThanOrEqual(1);
    expect(demandas[0]).toMatchObject({
      wa_id_masked: maskPhone(waId),
      servicoId: "limpeza",
    });
    expect(demandas[0]).toHaveProperty("timestamp");
    expect(JSON.stringify(demandas[0])).not.toContain(waId);

    // O telefone completo vive na fila de retorno, que é o que a recepção usa.
    const fila = listDemandasAbertas(store);
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({
      waId,
      servicoId: "limpeza",
      janelaDesejada: "terça de manhã",
      status: "ABERTA",
    });
  });

  it("preferência por domingo (indisponível) registra demanda", async () => {
    const { store, config } = setup();
    const waId = "551100000108";

    await proporHorarios(
      {
        store,
        config,
        calendar: calendarOk(),
        waId,
        agora: DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ }),
      },
      { servicoId: "limpeza", preferencia: "domingo de manhã" },
    );

    const demandas = eventsOfType(store, "demanda_nao_atendida");
    expect(demandas.some((d) => String(d.janela_desejada).includes("domingo"))).toBe(
      true,
    );
  });
});

describe("resumo humano", () => {
  it("resumo enviado contém telefone, intenção e motivo", async () => {
    const { store, config } = setup();
    const waId = "551100000109";
    let resumo = "";

    await transferToHuman({
      store,
      config,
      waId,
      motivo: "reclamacao",
      intencao: "cancelar cobrança indevida",
      userText: "isso é um absurdo",
      agora: DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ }),
      notifyHuman: async (_to, text) => {
        resumo = text;
      },
    });

    setConversationState(store, waId, "EM_HUMANO", {
      ...getConversation(store, waId)!.estado_payload,
      nomeCompleto: "Maria Silva",
    });

    // Re-transfer to include name — or just assert first summary fields
    expect(resumo).toContain(waId);
    expect(resumo).toContain("cancelar cobrança indevida");
    expect(resumo).toContain("reclamacao");
    expect(resumo).toMatch(/Telefone:/);
    expect(resumo).toMatch(/O que o cliente queria:/);
  });
});

describe("notificação da recepção não aborta a transferência", () => {
  it("notifyHuman rejeitando ainda silencia o paciente e registra a falha observável", async () => {
    const { store, config } = setup();
    const waId = "5511987654321";
    const agora = DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ });

    const result = await transferToHuman({
      store,
      config,
      waId,
      motivo: "gatilho_explicito:atendente",
      intencao: "quero falar com atendente",
      userText: "quero falar com atendente",
      agora,
      notifyHuman: async () => {
        throw new Error("Graph API 400: (#131047) Message failed to send because more than 24 hours have passed");
      },
    });

    expect(result.estado).toBe("EM_HUMANO");
    expect(result.clientMessage).toBe(config.handoff.mensagem);
    expect(getConversation(store, waId)?.estado).toBe("EM_HUMANO");

    const transferidos = eventsOfType(store, "handoff.transferido");
    expect(transferidos).toHaveLength(1);
    expect(transferidos[0]?.notificacao_ok).toBe(false);

    const falhas = eventsOfType(store, "handoff.notificacao_falhou");
    expect(falhas).toHaveLength(1);
    expect(falhas[0]?.motivo).toBe("gatilho_explicito:atendente");
    expect(String(falhas[0]?.erro)).toMatch(/Graph API 400/);
    expect(String(falhas[0]?.wa_id_masked)).toBe(maskPhone(waId));
    expect(String(falhas[0]?.numero_humano_masked)).toBe(
      maskPhone(config.handoff.numero_humano),
    );

    const serialized = JSON.stringify(falhas[0]);
    expect(serialized).not.toContain(waId);
    expect(serialized).not.toContain(config.handoff.numero_humano.replace(/\D/g, ""));
    expect(serialized).not.toContain("quero falar com atendente");
  });

  it("notifyHuman bem-sucedido grava notificacao_ok true e não gera falha", async () => {
    const { store, config } = setup();
    const waId = "551100000201";
    let called = 0;

    await transferToHuman({
      store,
      config,
      waId,
      motivo: "urgencia_clinica",
      agora: DateTime.fromISO("2026-07-28T12:00:00", { zone: TZ }),
      notifyHuman: async () => {
        called += 1;
      },
    });

    expect(called).toBe(1);
    const transferidos = eventsOfType(store, "handoff.transferido");
    expect(transferidos).toHaveLength(1);
    expect(transferidos[0]?.notificacao_ok).toBe(true);
    expect(eventsOfType(store, "handoff.notificacao_falhou")).toHaveLength(0);
  });
});
