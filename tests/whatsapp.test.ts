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
import { deleteUserData } from "../src/brain/privacy.js";

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

  it("sendText usa graphApiBaseUrl customizado (ex.: localhost de captura)", async () => {
    const store = tempStore();
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "out-local" }] }), {
        status: 200,
      }),
    );

    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone-local",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
      graphApiBaseUrl: "http://localhost:4000",
    });

    await channel.sendText("5511999998888", "ping");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/phone-local/messages");
    store.close();
  });

  it("sendText sem graphApiBaseUrl usa a Graph oficial", async () => {
    const store = tempStore();
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "out-official" }] }), {
        status: 200,
      }),
    );

    const channel = createWhatsappChannel({
      store,
      phoneNumberId: "phone-official",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
    });

    await channel.sendText("5511999998888", "ping");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v21.0/phone-official/messages",
    );
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

describe("privacidade e persistência do canal", () => {
  const okFetch = () =>
    vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  function canal(store: Store, fetchFn: ReturnType<typeof okFetch>) {
    return createWhatsappChannel({
      store,
      phoneNumberId: "phone",
      accessToken: "token",
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      fetchFn,
    });
  }

  it("evento de entrada não guarda o texto cru do paciente", async () => {
    const store = tempStore();
    const channel = canal(store, okFetch());

    await channel.processWebhookPayload(
      textPayload("wamid.pii", "estou com dor e sangramento no siso") as never,
    );

    const eventos = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .all("whatsapp.inbound_text") as Array<{ payload_json: string }>;

    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload_json).not.toContain("sangramento");
    expect(eventos[0]!.payload_json).not.toContain("5511999998888");
    expect(JSON.parse(eventos[0]!.payload_json).length).toBe(
      "estou com dor e sangramento no siso".length,
    );

    // O conteúdo continua em messages, que tem exclusão e expurgo.
    const msg = store.db
      .prepare(`SELECT texto FROM messages WHERE wa_message_id = ?`)
      .get("wamid.pii") as { texto: string };
    expect(msg.texto).toContain("sangramento");
    store.close();
  });

  it("sendText não cria conversa para quem não tem uma", async () => {
    const store = tempStore();
    const fetchFn = okFetch();
    const channel = canal(store, fetchFn);

    // Número da recepção recebendo resumo de handoff: não é paciente.
    await channel.sendText("5511977776666", "🔁 Transferência do chatbot");

    const conv = store.db
      .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE wa_id = ?`)
      .get("5511977776666") as { n: number };
    expect(conv.n).toBe(0);

    const evento = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .get("whatsapp.outbound") as { payload_json: string };
    expect(JSON.parse(evento.payload_json).conversa_registrada).toBe(false);
    store.close();
  });

  it("exclusão LGPD não é desfeita pela confirmação enviada em seguida", async () => {
    const store = tempStore();
    const fetchFn = okFetch();
    const channel = canal(store, fetchFn);
    const waId = "5511999998888";

    await channel.processWebhookPayload(textPayload("wamid.1", "oi") as never);
    expect(
      (store.db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as { n: number }).n,
    ).toBe(1);

    // O agente apaga tudo...
    deleteUserData(store, waId);
    // ...e o canal envia a confirmação logo depois.
    await channel.sendText(waId, "Pronto, apaguei seus dados.");

    const conv = store.db
      .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE wa_id = ?`)
      .get(waId) as { n: number };
    const msgs = store.db
      .prepare(`SELECT COUNT(*) AS n FROM messages`)
      .get() as { n: number };
    expect(conv.n).toBe(0);
    expect(msgs.n).toBe(0);
    store.close();
  });

  it("falha definitiva de envio vira evento observável", async () => {
    const store = tempStore();
    const fetchFn = vi.fn(async () => new Response("nope", { status: 400 }));
    const channel = canal(store, fetchFn as never);

    await expect(channel.sendText("5511999998888", "oi")).rejects.toThrow();

    const falhas = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .all("whatsapp.send_failed") as Array<{ payload_json: string }>;
    expect(falhas).toHaveLength(1);
    expect(JSON.parse(falhas[0]!.payload_json).status).toBe(400);
    expect(JSON.parse(falhas[0]!.payload_json).destino).toBe("paciente");
    store.close();
  });

  it("falha de envio para a recepção marca destino humano", async () => {
    const store = tempStore();
    const fetchFn = vi.fn(async () => new Response("window closed", { status: 400 }));
    const channel = canal(store, fetchFn as never);

    await expect(
      channel.sendText("5511977776666", "resumo", { destino: "humano" }),
    ).rejects.toThrow();

    const falhas = store.db
      .prepare(`SELECT payload_json FROM events WHERE tipo = ?`)
      .all("whatsapp.send_failed") as Array<{ payload_json: string }>;
    expect(JSON.parse(falhas[0]!.payload_json).destino).toBe("humano");
    store.close();
  });
});
