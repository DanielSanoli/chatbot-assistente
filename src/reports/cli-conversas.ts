import { openStore } from "../store/index.js";
import { parseArgs } from "./args.js";
import { buildDayTranscript } from "./transcript.js";

function main(): void {
  const args = parseArgs(process.argv);
  const dia = typeof args.dia === "string" ? args.dia : null;
  if (!dia) {
    console.error("Uso: npm run conversas -- --dia YYYY-MM-DD");
    process.exit(1);
  }

  const sqlitePath = process.env.SQLITE_PATH ?? "./data/chatbot.db";
  const zone = process.env.REPORT_TZ ?? "America/Sao_Paulo";
  const store = openStore(sqlitePath);

  try {
    const text = buildDayTranscript(store, dia, zone);
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
  } finally {
    store.close();
  }
}

main();
