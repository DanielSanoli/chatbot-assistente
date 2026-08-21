import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config/index.js";
import {
  authorizationMatches,
  registerHealthRoutes,
} from "../src/health.js";
import { logEvent, openStore, type Store } from "../src/store/index.js";

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

const TOKEN = "health-secret-token";

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
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
  return { store, config };
}

async function appWith(opts: { healthToken?: string }) {
  const { store, config } = setup();
  const app = Fastify();
  registerHealthRoutes(app, { store, config, healthToken: opts.healthToken });
  return { app, store, config };
}

describe("authorizationMatches", () => {
  it("aceita Bearer e token cru com comparação time-safe", () => {
    expect(authorizationMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorizationMatches(TOKEN, TOKEN)).toBe(true);
  });

  it("rejeita token errado e comprimento diferente sem lançar", () => {
    expect(authorizationMatches("Bearer x", TOKEN)).toBe(false);
    expect(authorizationMatches("Bearer", TOKEN)).toBe(false);
    expect(authorizationMatches(undefined, TOKEN)).toBe(false);
  });
});

describe("GET /health", () => {
  it("sem header responde 200 e não contém cliente.id", async () => {
    const { app, config } = await appWith({ healthToken: TOKEN });
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({ ok: true });
    expect(res.body).not.toContain(config.cliente.id);
    expect(body).not.toHaveProperty("cliente");
    expect(body).not.toHaveProperty("degradado");
    expect(body).not.toHaveProperty("timezone");
    await app.close();
  });
});

describe("GET /health/detalhe", () => {
  it("sem header responde 401", async () => {
    const { app } = await appWith({ healthToken: TOKEN });
    const res = await app.inject({ method: "GET", url: "/health/detalhe" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/clinica/i);
    await app.close();
  });

  it("com token errado responde 401", async () => {
    const { app, config } = await appWith({ healthToken: TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/health/detalhe",
      headers: { authorization: "Bearer token-errado-xyz" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(config.cliente.id);
    await app.close();
  });

  it("com token certo responde 200 com o payload completo", async () => {
    const { app, store, config } = await appWith({ healthToken: TOKEN });
    logEvent(store, "whatsapp.inbound_text", { wa_id_masked: "5511****0000" });
    logEvent(store, "brain.error", { error: "credit" });
    logEvent(store, "whatsapp.send_failed", { destino: "paciente" });
    logEvent(store, "handoff.notificacao_falhou", { motivo: "x" });

    const res = await app.inject({
      method: "GET",
      url: "/health/detalhe",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      degradado: boolean;
      cliente: string;
      timezone: string;
      ultima_hora: {
        erros_claude: number;
        falhas_envio: number;
        handoff_notificacao_falhou: number;
        mensagens_recebidas: number;
      };
      ultimas_12h: { mensagens_recebidas: number };
    };
    expect(body.ok).toBe(true);
    expect(body.degradado).toBe(true);
    expect(body.cliente).toBe(config.cliente.id);
    expect(body.timezone).toBe(config.cliente.timezone);
    expect(body.ultima_hora.erros_claude).toBe(1);
    expect(body.ultima_hora.falhas_envio).toBe(1);
    expect(body.ultima_hora.handoff_notificacao_falhou).toBe(1);
    expect(body.ultima_hora.mensagens_recebidas).toBe(1);
    expect(body.ultimas_12h.mensagens_recebidas).toBe(1);
    await app.close();
  });

  it("sem HEALTH_TOKEN configurado responde 404", async () => {
    const { app } = await appWith({ healthToken: undefined });
    const res = await app.inject({
      method: "GET",
      url: "/health/detalhe",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    const publico = await app.inject({ method: "GET", url: "/health" });
    expect(publico.statusCode).toBe(200);
    expect(JSON.parse(publico.body)).toEqual({ ok: true });
    await app.close();
  });

  it("HEALTH_TOKEN vazio também responde 404 — nunca cai para sem autenticação", async () => {
    const { app } = await appWith({ healthToken: "   " });
    const res = await app.inject({ method: "GET", url: "/health/detalhe" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
