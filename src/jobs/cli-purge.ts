import { ConfigService } from "../config/index.js";
import { ConfigLoadError } from "../config/load.js";
import { openStore } from "../store/index.js";
import { parseArgs } from "../reports/args.js";
import { purgeFromConfig, purgeOldConversations } from "./purge.js";

function main(): void {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.error(
      "Uso: npm run expurgo -- [--dias N] [--dry-run]\n" +
        "  Sem --dias, usa privacidade.retencao_dias da config do cliente.\n" +
        "  --dry-run apenas conta o que seria removido, sem apagar nada.",
    );
    process.exit(0);
  }

  const configPath =
    process.env.CLIENT_CONFIG_PATH ?? "./clients/clinica-exemplo.yaml";
  const sqlitePath = process.env.SQLITE_PATH ?? "./data/chatbot.db";

  let config;
  try {
    config = ConfigService.load(configPath);
  } catch (err) {
    const message =
      err instanceof ConfigLoadError || err instanceof Error
        ? err.message
        : String(err);
    console.error(`Configuração inválida.\n${message}`);
    process.exit(1);
  }

  const diasOverride =
    typeof args.dias === "string" ? Number(args.dias) : undefined;
  if (diasOverride !== undefined && !Number.isInteger(diasOverride)) {
    console.error(`--dias inválido: ${String(args.dias)}`);
    process.exit(1);
  }

  const store = openStore(sqlitePath);

  try {
    if (args["dry-run"]) {
      const dias = diasOverride ?? config.privacidade.retencao_dias;
      const total = store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations
            WHERE atualizado_em < datetime('now', ?)`,
        )
        .get(`-${dias} days`) as { n: number };
      console.log(
        `[dry-run] ${total.n} conversa(s) com última atividade acima de ${dias} dias.`,
      );
      console.log(
        "[dry-run] Conversas EM_HUMANO dentro da janela de silêncio seriam preservadas.",
      );
      return;
    }

    const result =
      diasOverride !== undefined
        ? purgeOldConversations(store, diasOverride, {
            timezone: config.cliente.timezone,
            silencioEmHumanoHoras: config.handoff.silencio_em_humano_horas,
          })
        : purgeFromConfig(store, config);

    console.log(
      `Expurgo concluído: ${result.conversas} conversa(s) e ${result.mensagens} mensagem(ns) removidas.`,
    );
    if (result.preservadasEmHumano > 0) {
      console.log(
        `${result.preservadasEmHumano} conversa(s) preservada(s) por estarem EM_HUMANO ativo.`,
      );
    }
  } finally {
    store.close();
  }
}

main();
