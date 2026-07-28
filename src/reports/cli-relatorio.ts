import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { openStore } from "../store/index.js";
import { parseArgs } from "./args.js";
import { computeWeeklyReport, formatWeeklyReportText } from "./weekly.js";

function main(): void {
  const args = parseArgs(process.argv);
  if (!args.semana) {
    console.error(
      "Uso: npm run relatorio -- --semana [YYYY-MM-DD]\n" +
        "  Sem data, usa a semana corrente (segunda–domingo) no fuso do relatório.",
    );
    process.exit(1);
  }

  const zone = process.env.REPORT_TZ ?? "America/Sao_Paulo";
  const ref =
    typeof args.semana === "string"
      ? DateTime.fromISO(args.semana, { zone })
      : DateTime.now().setZone(zone);

  if (!ref.isValid) {
    console.error(`Data inválida para --semana: ${String(args.semana)}`);
    process.exit(1);
  }

  const sqlitePath = process.env.SQLITE_PATH ?? "./data/chatbot.db";
  const store = openStore(sqlitePath);

  try {
    const data = computeWeeklyReport(store, ref);
    const text = formatWeeklyReportText(data);
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");

    const reportsDir = resolve("reports");
    mkdirSync(reportsDir, { recursive: true });
    const fileName = `semana-${data.periodo.inicio}_${data.periodo.fim}.md`;
    const filePath = resolve(reportsDir, fileName);
    writeFileSync(filePath, text, "utf8");
    console.error(`Markdown salvo em ${filePath}`);
  } finally {
    store.close();
  }
}

main();
