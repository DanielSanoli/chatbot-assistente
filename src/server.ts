import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { ConfigService } from "./config/index.js";
import { ConfigLoadError } from "./config/load.js";
import { createWhatsappChannel } from "./channel/index.js";
import { createGoogleCalendarClient } from "./calendar/index.js";
import {
  createBrain,
  marcarAvisoLgpdEntregue,
  transferToHuman,
} from "./brain/index.js";
import { openStore, logEvent, countEventsSince } from "./store/index.js";
import { purgeFromConfig } from "./jobs/purge.js";
import { maskPhone } from "./channel/mask.js";
import { DateTime } from "luxon";

function loadDotEnv(filePath = ".env"): void {
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) return;

  const text = readFileSync(absolute, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falha na subida: variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();

  const configPath =
    process.env.CLIENT_CONFIG_PATH ?? "./clients/clinica-exemplo.yaml";
  const sqlitePath = process.env.SQLITE_PATH ?? "./data/chatbot.db";
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "3000");

  let config;
  try {
    config = ConfigService.load(configPath);
  } catch (err) {
    const message =
      err instanceof ConfigLoadError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`Falha na subida: configuração inválida.\n${message}`);
    process.exit(1);
  }

  const waVerifyToken = requireEnv("WA_VERIFY_TOKEN");
  const waAppSecret = requireEnv("WA_APP_SECRET");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");

  const store = openStore(sqlitePath);
  logEvent(store, "server.boot", {
    cliente_id: config.cliente.id,
    config_path: configPath,
  });

  const app = Fastify({ logger: true });

  const calendar = createGoogleCalendarClient();

  let sendText!: (waId: string, texto: string) => Promise<void>;

  const notifyHuman = async (numeroHumano: string, resumo: string) => {
    await sendText(numeroHumano.replace(/\D/g, ""), resumo, {
      destino: "humano",
    });
  };

  const brain = createBrain({
    store,
    apiKey: anthropicKey,
    calendar,
    notifyHuman,
  });

  const whatsapp = createWhatsappChannel({
    store,
    phoneNumberId: config.whatsapp.phone_number_id,
    accessToken: config.whatsapp.access_token,
    verifyToken: waVerifyToken,
    appSecret: waAppSecret,
    graphApiBaseUrl: process.env.GRAPH_API_BASE,
    logger: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
    onTextMessage: async ({ waId, text }) => {
      try {
        const turn = await brain.handleText(waId, text);
        if (turn.muted || turn.reply === null) {
          return;
        }
        await whatsapp.sendText(waId, turn.reply);
        // Só agora o aviso de LGPD existe de fato para o paciente.
        if (turn.avisoLgpdPendente) {
          marcarAvisoLgpdEntregue(store, waId);
        }
      } catch (err) {
        app.log.error(
          {
            wa_id: maskPhone(waId),
            err: err instanceof Error ? err.message : String(err),
          },
          "brain handleText failed",
        );
        logEvent(store, "brain.error", {
          wa_id_masked: maskPhone(waId),
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          const transfer = await transferToHuman({
            store,
            config,
            waId,
            motivo: "erro_interno:exception",
            intencao: text,
            userText: text,
            agora: DateTime.now().setZone(config.cliente.timezone),
            notifyHuman,
          });
          await whatsapp.sendText(waId, transfer.clientMessage);
        } catch (handoffErr) {
          app.log.error(
            {
              err:
                handoffErr instanceof Error
                  ? handoffErr.message
                  : String(handoffErr),
            },
            "handoff após erro também falhou",
          );
          await whatsapp.sendText(waId, config.handoff.mensagem);
        }
      }
    },
  });

  sendText = whatsapp.sendText.bind(whatsapp);
  whatsapp.registerRoutes(app);

  /**
   * `ok` responde "o processo está de pé". `degradado` responde a pergunta que
   * o log de chat expôs: com a chave da Anthropic sem crédito, TODA mensagem
   * vira handoff e o paciente fica mudo 12h — e nada disso aparece como erro.
   * Falha de envio entra junto: o webhook já respondeu 200, ninguém reenvia.
   * Falha de notificação da recepção: o paciente já está em EM_HUMANO e mudo;
   * se isso some, a clínica atende no escuro.
   */
  app.get("/health", async () => {
    const desde = DateTime.utc().minus({ hours: 1 }).toFormat("yyyy-LL-dd HH:mm:ss");
    const errosClaude = countEventsSince(store, ["brain.claude_error", "brain.error"], desde);
    const falhasEnvio = countEventsSince(store, ["whatsapp.send_failed"], desde);
    const falhasNotificacao = countEventsSince(
      store,
      ["handoff.notificacao_falhou"],
      desde,
    );

    return {
      ok: true,
      degradado: errosClaude > 0 || falhasEnvio > 0 || falhasNotificacao > 0,
      cliente: config.cliente.id,
      timezone: config.cliente.timezone,
      ultima_hora: {
        erros_claude: errosClaude,
        falhas_envio: falhasEnvio,
        handoff_notificacao_falhou: falhasNotificacao,
      },
    };
  });

  // Expurgo LGPD: uma vez no boot e a cada 24h.
  const runPurge = () => {
    try {
      const result = purgeFromConfig(store, config);
      if (result.conversas > 0 || result.eventos > 0 || result.demandas > 0) {
        app.log.info(
          {
            conversas: result.conversas,
            mensagens: result.mensagens,
            eventos: result.eventos,
            demandas: result.demandas,
            agendamentos: result.agendamentos,
          },
          "expurgo lgpd concluído",
        );
      }
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "expurgo lgpd falhou",
      );
    }
  };
  runPurge();
  const purgeTimer = setInterval(runPurge, 24 * 60 * 60 * 1000);
  purgeTimer.unref();

  const shutdown = async () => {
    clearInterval(purgeTimer);
    await app.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host, port });
  app.log.info(
    {
      cliente: config.cliente.id,
      webhook: "/webhook",
      servicos: config.servicos.length,
    },
    "servidor pronto",
  );
}

main().catch((err) => {
  console.error("Falha fatal na subida:", err);
  process.exit(1);
});
