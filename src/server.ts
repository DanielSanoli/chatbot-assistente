import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { ConfigService } from "./config/index.js";
import { ConfigLoadError } from "./config/load.js";
import { createWhatsappChannel } from "./channel/index.js";
import { createGoogleCalendarClient } from "./calendar/index.js";
import { createBrain, transferToHuman } from "./brain/index.js";
import { openStore, logEvent } from "./store/index.js";
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
    await sendText(numeroHumano.replace(/\D/g, ""), resumo);
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

  app.get("/health", async () => ({
    ok: true,
    cliente: config.cliente.id,
    timezone: config.cliente.timezone,
  }));

  const shutdown = async () => {
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
