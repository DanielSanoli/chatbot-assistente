import { DateTime } from "luxon";
import { logEvent, type Store } from "../store/index.js";
import type { ClientConfig } from "../config/schema.js";

export type PurgeResult = {
  conversas: number;
  mensagens: number;
  /** Conversas elegíveis pela idade mas preservadas por estarem EM_HUMANO ativo. */
  preservadasEmHumano: number;
};

export type PurgeOptions = {
  /** Relógio injetável (testes). Default: agora. */
  now?: DateTime | Date;
  /** Timezone do cliente. Default: America/Sao_Paulo. */
  timezone?: string;
  /**
   * Janela de silêncio do handoff. Conversa EM_HUMANO dentro dessa janela não
   * é apagada, mesmo velha: há um humano atendendo agora.
   */
  silencioEmHumanoHoras?: number;
};

type Candidate = {
  id: number;
  estado: string;
  estado_payload: string | null;
  atualizado_em: string;
};

function resolveNow(options?: PurgeOptions): DateTime {
  const zone = options?.timezone ?? "America/Sao_Paulo";
  const raw = options?.now;
  if (raw instanceof DateTime) return raw.setZone(zone);
  if (raw instanceof Date) return DateTime.fromJSDate(raw).setZone(zone);
  return DateTime.now().setZone(zone);
}

/**
 * True se a conversa está EM_HUMANO e ainda dentro da janela de silêncio.
 * Sem `emHumanoDesde` gravado, trata como ativa — o conservador aqui é
 * preservar, não apagar.
 */
function emHumanoAtivo(
  row: Candidate,
  agora: DateTime,
  silencioHoras: number,
): boolean {
  if (row.estado !== "EM_HUMANO") return false;

  let desde: string | undefined;
  try {
    const payload = JSON.parse(row.estado_payload ?? "{}") as {
      emHumanoDesde?: string;
    };
    desde = payload.emHumanoDesde;
  } catch {
    return true;
  }

  if (!desde) return true;

  const inicio = DateTime.fromISO(desde, { zone: agora.zone });
  if (!inicio.isValid) return true;

  return agora.diff(inicio, "hours").hours < silencioHoras;
}

/**
 * Expurgo por idade (LGPD). Remove conversas cuja última atividade seja mais
 * antiga que `retencaoDias`, junto das mensagens.
 *
 * Aritmética de data com Luxon — `Date` nativo é proibido no projeto.
 */
export function purgeOldConversations(
  store: Store,
  retencaoDias: number,
  options?: PurgeOptions,
): PurgeResult {
  const agora = resolveNow(options);
  const silencioHoras = options?.silencioEmHumanoHoras ?? 12;
  const corte = agora.minus({ days: retencaoDias });

  // atualizado_em é gravado por datetime('now'), ou seja UTC no formato
  // "YYYY-MM-DD HH:MM:SS". O corte precisa ser comparado no mesmo formato.
  const corteSql = corte.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  const candidatos = store.db
    .prepare(
      `SELECT id, estado, estado_payload, atualizado_em
         FROM conversations
        WHERE atualizado_em < ?`,
    )
    .all(corteSql) as Candidate[];

  let conversas = 0;
  let mensagens = 0;
  let preservadasEmHumano = 0;

  const run = store.db.transaction((rows: Candidate[]) => {
    const delMessages = store.db.prepare(
      `DELETE FROM messages WHERE conversation_id = ?`,
    );
    const delConversation = store.db.prepare(
      `DELETE FROM conversations WHERE id = ?`,
    );

    for (const row of rows) {
      if (emHumanoAtivo(row, agora, silencioHoras)) {
        preservadasEmHumano += 1;
        continue;
      }
      mensagens += delMessages.run(row.id).changes;
      delConversation.run(row.id);
      conversas += 1;
    }
  });

  run(candidatos);

  if (conversas > 0 || preservadasEmHumano > 0) {
    logEvent(store, "lgpd.expurgo", {
      conversas,
      mensagens,
      preservadas_em_humano: preservadasEmHumano,
      retencao_dias: retencaoDias,
      corte: corteSql,
    });
  }

  return { conversas, mensagens, preservadasEmHumano };
}

/** Açúcar: lê retenção e janela de silêncio direto da config do cliente. */
export function purgeFromConfig(
  store: Store,
  config: ClientConfig,
  options?: Pick<PurgeOptions, "now">,
): PurgeResult {
  return purgeOldConversations(store, config.privacidade.retencao_dias, {
    ...options,
    timezone: config.cliente.timezone,
    silencioEmHumanoHoras: config.handoff.silencio_em_humano_horas,
  });
}
