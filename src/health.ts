import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import type { ClientConfig } from "./config/schema.js";
import { countEventsSince, type Store } from "./store/index.js";

export type HealthRoutesDeps = {
  store: Store;
  config: ClientConfig;
  /** Ausente ou vazio: /health/detalhe responde 404. Nunca fica público. */
  healthToken?: string;
};

function tokenEquals(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authorization: Bearer <token> (ou o token cru). Comparação time-safe,
 * mesmo padrão de verifyWhatsappSignature — comprimento diferente rejeita
 * sem chamar timingSafeEqual.
 */
export function authorizationMatches(
  header: string | string[] | undefined,
  expected: string,
): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : raw;
  return tokenEquals(token, expected);
}

function sinceSql(hours: number): string {
  return DateTime.utc().minus({ hours }).toFormat("yyyy-LL-dd HH:mm:ss");
}

export function buildHealthDetail(
  store: Store,
  config: ClientConfig,
): {
  ok: true;
  degradado: boolean;
  cliente: string;
  timezone: string;
  ultima_hora: {
    erros_claude: number;
    falhas_envio: number;
    handoff_notificacao_falhou: number;
    mensagens_recebidas: number;
  };
  ultimas_12h: {
    mensagens_recebidas: number;
  };
} {
  const desde1h = sinceSql(1);
  const desde12h = sinceSql(12);
  const errosClaude = countEventsSince(
    store,
    ["brain.claude_error", "brain.error"],
    desde1h,
  );
  const falhasEnvio = countEventsSince(store, ["whatsapp.send_failed"], desde1h);
  const falhasNotificacao = countEventsSince(
    store,
    ["handoff.notificacao_falhou"],
    desde1h,
  );
  const mensagens1h = countEventsSince(
    store,
    ["whatsapp.inbound_text"],
    desde1h,
  );
  const mensagens12h = countEventsSince(
    store,
    ["whatsapp.inbound_text"],
    desde12h,
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
      mensagens_recebidas: mensagens1h,
    },
    ultimas_12h: {
      mensagens_recebidas: mensagens12h,
    },
  };
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRoutesDeps,
): void {
  const token = deps.healthToken?.trim() || undefined;

  app.get("/health", async () => ({ ok: true }));

  app.get("/health/detalhe", async (request, reply) => {
    if (!token) {
      return reply.code(404).send({ error: "not found" });
    }
    if (!authorizationMatches(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return buildHealthDetail(deps.store, deps.config);
  });
}
