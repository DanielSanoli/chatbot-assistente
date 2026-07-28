import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsappChannel,
  UNSUPPORTED_MEDIA_REPLY,
  verifyWhatsappSignature,
} from "../src/channel/whatsapp.js";
import { maskPhone } from "../src/channel/mask.js";
import {
  countMessagesByWaMessageId,
  openStore,
  type Store,
} from "../src/store/index.js";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
  dirs.push(dir);
  return openStore(join(dir, "test.db"));
}

function sign(body: string | Buffer, secret = APP_SECRET): string {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function textPayload(waMessageId: string, text = "olá"): object {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "5511999998888",
                  id: waMessageId,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function mediaPayload(waMessageId: string, type = "image"): object {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "5511999998888",
                  id: waMessageId,
                  timestamp: "1700000000",
                  type,
                  [type]: { id: "media-1" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function flushBackground(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("maskPhone", () => {
  it("mascara o número", () => {
    expect(maskPhone("5511999998888")).toBe("5511****8888");
  });
});

describe("verifyWhatsappSignature", () => {
  it("aceita assinatura válida com comparação time-safe", () => {
    const raw = Buffer.from('{"ok":true}', "utf8");
    expect(verifyWhatsappSignature(raw, sign(raw), APP_SECRET)).toBe(true);
  });

  it("rejeita assinatura inválida", () => {
    const raw = Buffer.from('{"ok":true}', "utf8");
    expect(
      verifyWhatsappSignature(raw, "sha256=deadbeef", APP_SECRET),
    ).toBe(false);
  });
});

describe("webhook HTTP", () => {
  it("GET /webhook verifica hub.challenge com WA_VERIFY_TOKEN", async () => {
    const store = tempStore();
    const app = Fastify();
    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: vi.fn(),
    });
    channel.registerRoutes(app);

    const res = await app.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "challenge-123",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("challenge-123");
    await app.close();
    store.close();
  });

  it("GET /webhook rejeita token inválido", async () => {
    const store = tempStore();
    const app = Fastify();
    createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: vi.fn(),
    }).registerRoutes(app);

    const res = await app.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge-123",
      },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
    store.close();
  });

  it("POST /webhook com assinatura inválida retorna 401 e não processa", async () => {
    const store = tempStore();
    const onText = vi.fn();
    const app = Fastify();
    createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: vi.fn(),
      onTextMessage: onText,
    }).registerRoutes(app);

    const body = JSON.stringify(textPayload("wamid.invalid"));
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=00".repeat(32),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    await flushBackground();
    expect(onText).not.toHaveBeenCalled();
    expect(countMessagesByWaMessageId(store, "wamid.invalid")).toBe(0);
    await app.close();
    store.close();
  });

  it("POST /webhook responde 200 imediatamente", async () => {
    const store = tempStore();
    let resolveProcess!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveProcess = resolve;
    });

    const app = Fastify();
    createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ messages: [{ id: "out-1" }] }), {
          status: 200,
        }),
      ),
      onTextMessage: async () => {
        await gate;
      },
    }).registerRoutes(app);

    const body = JSON.stringify(textPayload("wamid.fast"));
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("EVENT_RECEIVED");
    resolveProcess();
    await flushBackground();
    await app.close();
    store.close();
  });
});

describe("processamento inbound", () => {
  it("mesmo wa_message_id duas vezes → uma gravação", async () => {
    const store = tempStore();
    const onText = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "out-echo" }] }), {
        status: 200,
      }),
    );

    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
      onTextMessage: onText,
    });

    const payload = textPayload("wamid.dup", "oi");
    await channel.processWebhookPayload(payload);
    await channel.processWebhookPayload(payload);

    expect(countMessagesByWaMessageId(store, "wamid.dup")).toBe(1);
    expect(onText).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("mensagem de mídia não entra no fluxo de texto", async () => {
    const store = tempStore();
    const onText = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "out-media" }] }), {
        status: 200,
      }),
    );

    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
      onTextMessage: onText,
    });

    await channel.processWebhookPayload(mediaPayload("wamid.img", "image"));

    expect(onText).not.toHaveBeenCalled();
    expect(countMessagesByWaMessageId(store, "wamid.img")).toBe(1);

    const outbound = store.db
      .prepare(`SELECT texto FROM messages WHERE direcao = 'out' LIMIT 1`)
      .get() as { texto: string };
    expect(outbound.texto).toBe(UNSUPPORTED_MEDIA_REPLY);

    const sentBody = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    ) as { text: { body: string } };
    expect(sentBody.text.body).toBe(UNSUPPORTED_MEDIA_REPLY);
    store.close();
  });

  it("texto dispara eco via sendText (Graph API)", async () => {
    const store = tempStore();
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "out-1" }] }), {
        status: 200,
      }),
    );

    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone-123",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
      graphApiBaseUrl: "https://graph.test",
    });

    await channel.processWebhookPayload(textPayload("wamid.txt", "eco-me"));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://graph.test/phone-123/messages");
    const body = JSON.parse(init.body as string) as {
      to: string;
      text: { body: string };
    };
    expect(body.to).toBe("5511999998888");
    expect(body.text.body).toBe("eco-me");
    expect(countMessagesByWaMessageId(store, "wamid.txt")).toBe(1);
    store.close();
  });
});

describe("sendText retry", () => {
  it("retria em 5xx e 429, não em 4xx", async () => {
    const store = tempStore();
    const fetch5xx = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("err", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "out-ok" }] }), {
          status: 200,
        }),
      );

    const channelOk = createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: fetch5xx,
      graphApiBaseUrl: "https://graph.test",
    });

    await channelOk.sendText("5511888777666", "oi");
    expect(fetch5xx).toHaveBeenCalledTimes(3);

    const fetch4xx = vi.fn().mockResolvedValue(
      new Response("bad", { status: 400 }),
    );
    const channel4xx = createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn: fetch4xx,
      graphApiBaseUrl: "https://graph.test",
    });

    await expect(channel4xx.sendText("5511888777666", "oi")).rejects.toThrow(
      /Graph API 400/,
    );
    expect(fetch4xx).toHaveBeenCalledTimes(1);
    store.close();
  });
});
