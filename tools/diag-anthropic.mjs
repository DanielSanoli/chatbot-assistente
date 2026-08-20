import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

function loadDotEnv(filePath = ".env") {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const key = process.env.ANTHROPIC_API_KEY ?? "";
const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

console.log("key_present=", key.length > 20);
console.log("key_format_ok=", key.startsWith("sk-ant-"));
console.log("looks_placeholder=", /dev-key|example|xxxx|changeme/i.test(key));
console.log("model=", model);

if (!key || !key.startsWith("sk-ant-") || /dev-key|example/i.test(key)) {
  console.log("api_status=SKIP — chave ausente ou placeholder no .env");
  process.exit(1);
}

const client = new Anthropic({ apiKey: key });
try {
  const r = await client.messages.create({
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: "Responda só com a palavra ok" }],
  });
  const text =
    r.content?.[0]?.type === "text" ? r.content[0].text : String(r.stop_reason);
  console.log("api_status=OK");
  console.log("reply=", String(text).slice(0, 80));
} catch (e) {
  console.log("api_status=FAIL");
  console.log("http_status=", e?.status ?? e?.statusCode ?? "");
  console.log("error_type=", e?.error?.type ?? e?.type ?? "");
  console.log("message=", String(e?.message ?? e).slice(0, 500));
  process.exit(1);
}
