import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/brain/agent.js";
import { buildSystemPrompt } from "../src/brain/prompt.js";
import type { CalendarClient } from "../src/calendar/google.js";
import { ConfigService } from "../src/config/index.js";
import {
  insertAppointment,
  listActiveAppointments,
  openStore,
  tryInsertMessage,
  upsertConversation,
  type Store,
} from "../src/store/index.js";

const TZ = "America/Sao_Paulo";
import {
  createScriptedClaude,
  lastUserText,
  textResult,
  toolUseResult,
} from "./helpers/claudeMock.js";

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

const noopNotifyHuman = async () => undefined;

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  ConfigService.reset();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { store: Store; config: ReturnType<typeof ConfigService.load> } {
  const dir = mkdtempSync(join(tmpdir(), "brain-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
  return { store, config };
}

function seedInbound(store: Store, waId: string, text: string): void {
  const conversationId = upsertConversation(store, waId);
  tryInsertMessage(store, {
    conversationId,
    direcao: "in",
    texto: text,
    waMessageId: `wamid.${Math.random().toString(16).slice(2)}`,
  });
}

function eventsOfType(store: Store, tipo: string): unknown[] {
  return store.db
    .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
    .all(tipo)
    .map((row) => JSON.parse((row as { payload_json: string }).payload_json));
}

/** Corpo da resposta sem o prefixo LGPD (se presente). */
function replyBody(
  reply: string | null | undefined,
  aviso: string,
): string {
  if (!reply) return "";
  if (reply.startsWith(aviso)) {
    return reply.slice(aviso.length).replace(/^\n\n/, "");
  }
  return reply;
}

describe("system prompt", () => {
  it("não contém preços nem horários de funcionamento", () => {
    const { config } = setup();
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(config.cliente.nome);
    expect(prompt).toContain(config.tom_de_voz.estilo);
    expect(prompt).toMatch(/REGRA CENTRAL/);
    expect(prompt).not.toMatch(/\b180\b/);
    expect(prompt).not.toMatch(/\b280\b/);
    expect(prompt).not.toMatch(/08:00/);
    expect(prompt).not.toMatch(/18:00/);
    expect(prompt).not.toContain(config.local.endereco);
  });
});

describe("agent conversation", () => {
  it('"quanto custa limpeza" retorna exatamente o preço do YAML', async () => {
    const { store, config } = setup();
    const preco = config.servicos.find((s) => s.id === "limpeza")!.preco!;
    const waId = "551100000001";
    seedInbound(store, waId, "quanto custa limpeza");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => toolUseResult("buscar_servico", { termo: "limpeza" }),
        () => textResult(`A limpeza dental custa R$ ${preco}.`),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "quanto custa limpeza");
    expect(turn.handoff).toBe(false);
    expect(turn.reply ?? "").toContain(String(preco));
    expect(turn.ferramentas).toContain("buscar_servico");
    expect(turn.respostaSemFonte).toBe(false);
  });

  it('"quanto custa canal" (preco null) NÃO retorna valor e aciona handoff', async () => {
    const { store, config } = setup();
    const waId = "551100000002";
    seedInbound(store, waId, "quanto custa canal");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => toolUseResult("buscar_servico", { termo: "canal" }),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "quanto custa canal");
    expect(turn.handoff).toBe(true);
    const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
    expect([config.handoff.mensagem, config.handoff.fora_do_horario]).toContain(
      body,
    );
    expect(turn.ferramentas).toEqual(
      expect.arrayContaining(["buscar_servico", "acionar_handoff"]),
    );
    expect(body).not.toMatch(/\d{2,}/);
    expect(eventsOfType(store, "brain.turno")[0]).toMatchObject({
      handoff: true,
    });
  });

  it('"vocês fazem implante" não inventa e aciona handoff', async () => {
    const { store, config } = setup();
    const waId = "551100000003";
    seedInbound(store, waId, "vocês fazem implante");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => toolUseResult("buscar_servico", { termo: "implante" }),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "vocês fazem implante");
    expect(turn.handoff).toBe(true);
    const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
    expect([config.handoff.mensagem, config.handoff.fora_do_horario]).toContain(
      body,
    );
    expect(body.toLowerCase()).not.toContain("implante dentário");
    expect(turn.ferramentas).toContain("acionar_handoff");
  });

  it('alias "tártaro" resolve para limpeza com preço correto', async () => {
    const { store, config } = setup();
    const preco = config.servicos.find((s) => s.id === "limpeza")!.preco!;
    const waId = "551100000004";
    seedInbound(store, waId, "quanto custa tártaro");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        ({ messages }) => {
          const text = lastUserText(messages);
          expect(text.toLowerCase()).toContain("tártaro");
          return toolUseResult("buscar_servico", { termo: "tártaro" });
        },
        () => textResult(`A limpeza (tártaro/profilaxia) custa R$ ${preco}.`),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "quanto custa tártaro");
    expect(turn.reply ?? "").toContain(String(preco));
    expect(turn.handoff).toBe(false);
  });

  it("pergunta sobre estacionamento usa info_local", async () => {
    const { store, config } = setup();
    const waId = "551100000005";
    seedInbound(store, waId, "tem estacionamento?");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        () => toolUseResult("info_local", {}),
        () =>
          textResult(
            `Sim. ${config.local.estacionamento}`,
          ),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "tem estacionamento?");
    expect(turn.ferramentas).toContain("info_local");
    expect(turn.reply ?? "").toContain("estacionamento");
    expect(turn.handoff).toBe(false);
  });

  it("resposta sem ferramenta registra evento resposta_sem_fonte", async () => {
    const { store, config } = setup();
    const waId = "551100000006";
    seedInbound(store, waId, "oi");

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([() => textResult("Olá! Como posso ajudar?")]),
    });

    const turn = await agent.handleUserMessage(waId, "oi");
    expect(turn.respostaSemFonte).toBe(true);
    expect(eventsOfType(store, "resposta_sem_fonte")).toHaveLength(1);
  });

  it("aceite: 20 perguntas de preço/serviço sem inventar valor fora do YAML", async () => {
    const { store, config } = setup();
    const precosPermitidos = new Set(
      config.servicos
        .filter((s) => s.preco !== null)
        .map((s) => String(s.preco)),
    );
    const comPrecoNull = config.servicos.filter((s) => s.preco === null);

    const perguntas = [
      "quanto custa limpeza",
      "preço da limpeza",
      "valor da profilaxia",
      "quanto é tártaro",
      "quanto custa canal",
      "preço do tratamento de canal",
      "vocês fazem implante",
      "tem clareamento?",
      "quanto custa consulta",
      "valor da avaliação",
      "preço da avaliacao completa",
      "fazem ortodontia?",
      "quanto custa endodontia",
      "limpeza quanto fica",
      "canal tem valor?",
      "implante dentário preço",
      "vocês fazem limpeza?",
      "quanto custa retorno",
      "preço de restauração",
      "valor do canal",
    ];

    expect(perguntas).toHaveLength(20);

    for (const [index, pergunta] of perguntas.entries()) {
      const waId = `5511999${String(index).padStart(4, "0")}`;
      seedInbound(store, waId, pergunta);

      const agent = createAgent({
        store,
        calendar: noopCalendar(),
        notifyHuman: noopNotifyHuman,
        getConfig: () => config,
        claude: createScriptedClaude([
          ({ messages }) => {
            const text = lastUserText(messages).toLowerCase();
            let termo = "desconhecido";
            if (text.includes("tártaro") || text.includes("tartaro") || text.includes("profilaxia") || text.includes("limpeza")) {
              termo = text.includes("tártaro") || text.includes("tartaro")
                ? "tártaro"
                : text.includes("profilaxia")
                  ? "profilaxia"
                  : "limpeza";
            } else if (text.includes("canal") || text.includes("endodontia")) {
              termo = text.includes("endodontia") ? "endodontia" : "canal";
            } else if (text.includes("consulta")) {
              termo = "consulta";
            } else if (text.includes("avalia")) {
              termo = "avaliacao";
            } else if (text.includes("implante")) {
              termo = "implante";
            } else if (text.includes("clareamento")) {
              termo = "clareamento";
            } else if (text.includes("ortodontia")) {
              termo = "ortodontia";
            } else if (text.includes("retorno")) {
              termo = "retorno";
            } else if (text.includes("restaura")) {
              termo = "restauracao";
            }
            return toolUseResult("buscar_servico", { termo }, `tool_${index}`);
          },
          ({ messages }) => {
            // Só chega aqui se não houve handoff forçado.
            const toolMsg = messages[messages.length - 1];
            const content = Array.isArray(toolMsg?.content)
              ? toolMsg.content
              : [];
            const toolResult = content.find(
              (b) =>
                typeof b === "object" &&
                b !== null &&
                "type" in b &&
                b.type === "tool_result",
            ) as { content?: string } | undefined;
            const parsed = JSON.parse(toolResult?.content ?? "{}") as {
              encontrado?: boolean;
              preco?: number | null;
              preco_status?: string;
              nome?: string;
            };
            if (
              parsed.encontrado &&
              parsed.preco_status === "informado" &&
              typeof parsed.preco === "number"
            ) {
              return textResult(`${parsed.nome} custa R$ ${parsed.preco}.`);
            }
            return textResult(config.handoff.mensagem);
          },
        ]),
      });

      const turn = await agent.handleUserMessage(waId, pergunta);

      // Nenhum valor numérico de preço fora do YAML.
      const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
      const mentioned = body.match(/R\$\s*(\d+(?:[.,]\d+)?)/gi) ?? [];
      for (const hit of mentioned) {
        const digits = hit.replace(/[^\d]/g, "");
        expect(precosPermitidos.has(digits)).toBe(true);
      }

      const lower = pergunta.toLowerCase();
      const asksNullPriceService = comPrecoNull.some(
        (s) =>
          lower.includes(s.id) ||
          lower.includes(s.nome.toLowerCase()) ||
          s.aliases.some((a) => lower.includes(a.toLowerCase())),
      );
      const asksUnknown =
        lower.includes("implante") ||
        lower.includes("clareamento") ||
        lower.includes("ortodontia") ||
        lower.includes("restaura") ||
        lower.includes("retorno");

      if (asksNullPriceService || asksUnknown) {
        expect(turn.handoff).toBe(true);
        expect([
          config.handoff.mensagem,
          config.handoff.fora_do_horario,
        ]).toContain(body);
      }
    }
  });
});

describe("cancelamento em cima da hora", () => {
  it("transfere mesmo se o modelo tentar dizer que cancelou", async () => {
    const { store, config } = setup();
    const waId = "551100000090";
    const calendar = noopCalendar();
    let deletou = false;
    calendar.deleteEvent = async () => {
      deletou = true;
    };

    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });
    // clinica-exemplo exige 24h; este horário está a 3h de distância.
    insertAppointment(store, {
      waId,
      servicoId: "limpeza",
      servicoNome: "Limpeza dental",
      profissionalId: "dra-ana",
      profissionalNome: "Dra. Ana Silva",
      calendarioId: "ana@example.com",
      eventId: "evt-proximo",
      inicio: agora.plus({ hours: 3 }).toISO() ?? "",
      fim: agora.plus({ hours: 3, minutes: 45 }).toISO() ?? "",
      nome: "Maria Silva",
    });

    const agent = createAgent({
      store,
      calendar,
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      now: () => agora.toJSDate(),
      claude: createScriptedClaude([
        () => toolUseResult("cancelar_agendamento", { confirmado: true }),
        () => textResult("Pronto, cancelei sua consulta!"),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "cancela minha consulta");

    expect(turn.handoff).toBe(true);
    expect(deletou).toBe(false);
    const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
    expect(body).not.toMatch(/cancelei|cancelad/i);
    expect([
      config.handoff.mensagem,
      config.handoff.fora_do_horario,
    ]).toContain(body);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
  });
});

describe("serviço não agendável força handoff", () => {
  // Serviço COM preço e SEM agendamento automático — a combinação que o freio
  // de preço não pega. É o caso dos outros verticais (pacote com valor de
  // tabela, mas agenda montada à mão).
  function configComServicoManual() {
    const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
    const canal = config.servicos.find((s) => s.id === "canal")!;
    canal.preco = 1200;
    canal.agendavel = false;
    return config;
  }

  it("propor_horarios em serviço manual transfere mesmo sem o modelo pedir", async () => {
    const { store } = setup();
    const config = configComServicoManual();
    const waId = "551100000091";

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      claude: createScriptedClaude([
        // O modelo tenta agendar direto e depois insiste em responder sozinho.
        () => toolUseResult("propor_horarios", { servicoId: "canal" }),
        () => textResult("Consegui um horário para o seu canal na terça!"),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "quero marcar um canal");

    expect(turn.handoff).toBe(true);
    expect(turn.ferramentas).toContain("acionar_handoff");
    const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
    expect([config.handoff.mensagem, config.handoff.fora_do_horario]).toContain(body);
    expect(body).not.toMatch(/terça|consegui um horário/i);

    const motivos = eventsOfType(store, "handoff.transferido").map(
      (e) => (e as { motivo?: string }).motivo,
    );
    expect(motivos).toContain("servico_nao_agendavel");
  });

  it("remarcar_agendamento em serviço manual também transfere", async () => {
    const { store } = setup();
    const config = configComServicoManual();
    const waId = "551100000092";
    const agora = DateTime.fromISO("2026-07-27T08:00:00", { zone: TZ });

    insertAppointment(store, {
      waId,
      servicoId: "canal",
      servicoNome: "Tratamento de canal",
      profissionalId: "dra-ana",
      profissionalNome: "Dra. Ana Silva",
      calendarioId: "ana@example.com",
      eventId: "evt-canal",
      inicio: agora.plus({ days: 5 }).toISO() ?? "",
      fim: agora.plus({ days: 5, minutes: 90 }).toISO() ?? "",
      nome: "Maria Silva",
    });

    const agent = createAgent({
      store,
      calendar: noopCalendar(),
      notifyHuman: noopNotifyHuman,
      getConfig: () => config,
      now: () => agora.toJSDate(),
      claude: createScriptedClaude([
        () => toolUseResult("remarcar_agendamento", {}),
        () => textResult("Remarquei para quinta!"),
      ]),
    });

    const turn = await agent.handleUserMessage(waId, "preciso mudar meu canal");

    expect(turn.handoff).toBe(true);
    const body = replyBody(turn.reply, config.privacidade.aviso_primeira_mensagem);
    expect(body).not.toMatch(/remarquei|quinta/i);
    expect(listActiveAppointments(store, waId, agora)).toHaveLength(1);
  });
});
