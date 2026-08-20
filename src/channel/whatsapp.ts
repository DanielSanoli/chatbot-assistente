import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawServerDefault,
} from "fastify";
import type { Store } from "../store/index.js";
import { logEvent } from "../store/index.js";
import {
  findConversationId,
  tryInsertMessage,
  upsertConversation,
} from "../store/messages.js";
import { maskPhone } from "./mask.js";

export const UNSUPPORTED_MEDIA_REPLY =
  "No momento consigo ler só mensagens de texto. Pode escrever pra mim?";

const MEDIA_TYPES = new Set([
  "audio",
  "image",
  "document",
  "location",
  "video",
  "sticker",
]);

export type WhatsappChannelDeps = {
  store: Store;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  graphApiBaseUrl?: string;
  fetchFn?: typeof fetch;
  /** Chamado só para texto novo (após persistir). Default: eco. */
  onTextMessage?: (input: {
    waId: string;
    text: string;
    waMessageId: string;
  }) => Promise<void>;
  logger?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
    error: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

type IncomingMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
};

type WebhookPayload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: IncomingMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function verifyWhatsappSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const received = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const receivedBuf = Buffer.from(received, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(receivedBuf, expectedBuf);
}

export function createWhatsappChannel(deps: WhatsappChannelDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const graphBase =
    deps.graphApiBaseUrl ?? "https://graph.facebook.com/v21.0";
  const log = deps.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  async function sendText(
    waId: string,
    texto: string,
    options?: { destino?: "paciente" | "humano" },
  ): Promise<void> {
    const destino = options?.destino ?? "paciente";
    const url = `${graphBase}/${deps.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to: waId,
      type: "text",
      text: { body: texto },
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          messages?: Array<{ id?: string }>;
        };
        const outId = json.messages?.[0]?.id ?? null;
        // Só registra a saída em conversa que JÁ existe. Criar aqui ressuscitaria
        // quem acabou de pedir exclusão (a confirmação é enviada logo depois do
        // DELETE) e abriria conversa para o número da recepção nos handoffs.
        const conversationId = findConversationId(deps.store, waId);
        if (conversationId !== null) {
          tryInsertMessage(deps.store, {
            conversationId,
            direcao: "out",
            texto,
            waMessageId: outId,
          });
        }
        logEvent(deps.store, "whatsapp.outbound", {
          wa_id_masked: maskPhone(waId),
          wa_message_id: outId,
          length: texto.length,
          conversa_registrada: conversationId !== null,
        });
        log.info(
          { wa_id: maskPhone(waId), attempt, wa_message_id: outId },
          "whatsapp sendText ok",
        );
        return;
      }

      const status = response.status;
      const errText = await response.text().catch(() => "");
      lastError = new Error(
        `Graph API ${status}: ${errText.slice(0, 200)}`,
      );

      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === 3) {
        log.error(
          { wa_id: maskPhone(waId), status, attempt },
          "whatsapp sendText failed",
        );
        // O webhook já respondeu 200 à Meta, então ninguém reenvia por nós:
        // uma falha aqui é paciente sem resposta. Precisa ficar visível.
        logEvent(deps.store, "whatsapp.send_failed", {
          wa_id_masked: maskPhone(waId),
          status,
          tentativas: attempt,
          destino,
        });
        throw lastError;
      }

      const backoffMs = 100 * 2 ** (attempt - 1);
      log.warn(
        { wa_id: maskPhone(waId), status, attempt, backoffMs },
        "whatsapp sendText retry",
      );
      await sleep(backoffMs);
    }

    throw lastError ?? new Error("sendText failed");
  }

  async function defaultOnTextMessage(input: {
    waId: string;
    text: string;
    waMessageId: string;
  }): Promise<void> {
    await sendText(input.waId, input.text);
  }

  const onTextMessage = deps.onTextMessage ?? defaultOnTextMessage;

  async function processIncomingMessage(message: IncomingMessage): Promise<void> {
    const waId = message.from;
    const waMessageId = message.id;
    if (!waId || !waMessageId) {
      return;
    }

    const type = message.type ?? "unknown";
    const conversationId = upsertConversation(deps.store, waId);

    if (type === "text") {
      const text = message.text?.body ?? "";
      const inserted = tryInsertMessage(deps.store, {
        conversationId,
        direcao: "in",
        texto: text,
        waMessageId,
        timestamp: message.timestamp
          ? new Date(Number(message.timestamp) * 1000).toISOString()
          : undefined,
      });

      if (!inserted) {
        log.info(
          { wa_id: maskPhone(waId), wa_message_id: waMessageId },
          "whatsapp duplicate ignored",
        );
        logEvent(deps.store, "whatsapp.duplicate", {
          wa_id_masked: maskPhone(waId),
          wa_message_id: waMessageId,
        });
        return;
      }

      // Sem o texto: `events` é log de auditoria, e a mensagem crua do paciente
      // de clínica é dado de saúde. O conteúdo já vive em `messages`, que tem
      // exclusão por pedido e expurgo por retenção.
      logEvent(deps.store, "whatsapp.inbound_text", {
        wa_id_masked: maskPhone(waId),
        wa_message_id: waMessageId,
        length: text.length,
      });
      log.info(
        {
          wa_id: maskPhone(waId),
          wa_message_id: waMessageId,
          length: text.length,
        },
        "whatsapp inbound text",
      );

      await onTextMessage({ waId, text, waMessageId });
      return;
    }

    if (MEDIA_TYPES.has(type)) {
      const inserted = tryInsertMessage(deps.store, {
        conversationId,
        direcao: "in",
        texto: `[unsupported:${type}]`,
        waMessageId,
        timestamp: message.timestamp
          ? new Date(Number(message.timestamp) * 1000).toISOString()
          : undefined,
      });

      if (!inserted) {
        log.info(
          { wa_id: maskPhone(waId), wa_message_id: waMessageId },
          "whatsapp duplicate ignored",
        );
        return;
      }

      logEvent(deps.store, "whatsapp.inbound_unsupported", {
        wa_id_masked: maskPhone(waId),
        wa_message_id: waMessageId,
        type,
      });
      log.info(
        { wa_id: maskPhone(waId), wa_message_id: waMessageId, type },
        "whatsapp unsupported media",
      );

      await sendText(waId, UNSUPPORTED_MEDIA_REPLY);
      return;
    }

    logEvent(deps.store, "whatsapp.inbound_ignored", {
      wa_id_masked: maskPhone(waId),
      wa_message_id: waMessageId,
      type,
    });
  }

  async function processWebhookPayload(payload: WebhookPayload): Promise<void> {
    if (payload.object !== "whatsapp_business_account") {
      return;
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          try {
            await processIncomingMessage(message);
          } catch (err) {
            log.error(
              {
                wa_id: maskPhone(message.from ?? ""),
                wa_message_id: message.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "whatsapp process message failed",
            );
            logEvent(deps.store, "whatsapp.process_error", {
              wa_id_masked: maskPhone(message.from ?? ""),
              wa_message_id: message.id ?? null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }

  function registerRawBodyParser(app: FastifyInstance): void {
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (
        request: FastifyRequest,
        body: Buffer,
        done: (err: Error | null, result?: unknown) => void,
      ) => {
        request.rawBody = body;
        try {
          const json = JSON.parse(body.toString("utf8")) as unknown;
          done(null, json);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
  }

  function registerRoutes(app: FastifyInstance<RawServerDefault>): void {
    registerRawBodyParser(app);

    app.get("/webhook", async (request, reply) => {
      const query = request.query as {
        "hub.mode"?: string;
        "hub.verify_token"?: string;
        "hub.challenge"?: string;
      };

      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      if (mode === "subscribe" && token === deps.verifyToken && challenge) {
        log.info({}, "whatsapp webhook verified");
        return reply.code(200).type("text/plain").send(challenge);
      }

      log.warn({}, "whatsapp webhook verification failed");
      return reply.code(403).send("Forbidden");
    });

    app.post("/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-hub-signature-256"];
      const signatureHeader = Array.isArray(signature)
        ? signature[0]
        : signature;
      const rawBody = request.rawBody;

      if (
        !rawBody ||
        !verifyWhatsappSignature(rawBody, signatureHeader, deps.appSecret)
      ) {
        log.warn({}, "whatsapp invalid signature");
        return reply.code(401).send({ error: "invalid signature" });
      }

      // Responde 200 imediatamente; processa em background.
      reply.code(200).send("EVENT_RECEIVED");

      const payload = request.body as WebhookPayload;
      setImmediate(() => {
        void processWebhookPayload(payload);
      });
    });
  }

  return {
    name: "whatsapp" as const,
    ready: true,
    sendText,
    registerRoutes,
    processWebhookPayload,
    verifySignature: (rawBody: Buffer, header: string | undefined) =>
      verifyWhatsappSignature(rawBody, header, deps.appSecret),
  };
}

export type WhatsappChannel = ReturnType<typeof createWhatsappChannel>;
