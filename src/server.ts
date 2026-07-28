import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { ConfigService } from "./config/index.js";
import { ConfigLoadError } from "./config/load.js";
import { createWhatsappChannel } from "./channel/index.js";
import { createGoogleCalendarClient } from "./calendar/index.js";
import { createBrain } from "./brain/index.js";
import { openStore, logEvent } from "./store/index.js";

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

  const store = openStore(sqlitePath);
  logEvent(store, "server.boot", {
    cliente_id: config.cliente.id,
    config_path: configPath,
  });

  createWhatsappChannel();
  createGoogleCalendarClient();
  createBrain();

  const app = Fastify({ logger: true });

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
    `Cliente "${config.cliente.nome}" carregado de ${configPath} (${config.servicos.length} serviços)`,
  );
}

main().catch((err) => {
  console.error("Falha fatal na subida:", err);
  process.exit(1);
});
