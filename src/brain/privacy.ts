import { DateTime } from "luxon";
import { logEvent, marcarAvisoLgpdEnviado, type Store } from "../store/index.js";
import { deletePastAppointments } from "../store/appointments.js";
import { deleteDemandasByWaId } from "../store/demandas.js";
import { maskPhone } from "../channel/mask.js";
import { normalizeTerm } from "./normalize.js";

/**
 * Confirmação de exclusão (LGPD).
 *
 * Diz explicitamente que o compromisso já marcado permanece na agenda: a
 * clínica é a controladora do atendimento, e apagar a conversa não desmarca
 * ninguém. Prometer o contrário seria pior que não ter o comando.
 */
export const DELETE_CONFIRMATION_MESSAGE = [
  "Pronto, apaguei desta conversa o seu nome, as mensagens e o histórico de atendimento.",
  "",
  "Se você já tinha um horário marcado, ele continua na agenda da clínica — se quiser desmarcar, é só me pedir.",
].join("\n");

/**
 * Frases de pedido de exclusão. Comparadas por inclusão sobre o texto
 * normalizado (minúsculo, sem acento), então "Quero EXCLUIR MEUS DADOS, por
 * favor" também casa.
 */
const DELETE_PHRASES = [
  "excluir meus dados",
  "exclua meus dados",
  "apagar meus dados",
  "apague meus dados",
  "deletar meus dados",
  "delete meus dados",
  "remover meus dados",
  "remova meus dados",
  "quero meus dados excluidos",
  "quero meus dados apagados",
  "excluir minhas informacoes",
  "apagar minhas informacoes",
  "excluir meus dados pessoais",
  "apagar meus dados pessoais",
];

export function detectDeleteRequest(text: string): boolean {
  const normalized = normalizeTerm(text).replace(/\s+/g, " ");
  if (!normalized) return false;
  return DELETE_PHRASES.some((phrase) => normalized.includes(phrase));
}

export const TEXTO_EXPURGADO = "[expurgado a pedido do titular]";

const CAMPOS_TEXTO = new Set(["user_text", "intencao", "texto"]);

export type DeleteUserDataResult = {
  /** Mensagens removidas. 0 se o wa_id não existia. */
  mensagens: number;
  /** True se havia uma conversa registrada para o wa_id. */
  conversaRemovida: boolean;
  /** Agendamentos passados/cancelados removidos. Os futuros são preservados. */
  agendamentosRemovidos: number;
  /** Linhas da fila de retorno removidas (guardam telefone completo). */
  demandasRemovidas: number;
  /** Linhas de events cujo texto livre foi substituído pelo marcador. */
  eventosExpurgados: number;
};

function deveExpurgarCampo(key: string): boolean {
  return CAMPOS_TEXTO.has(key) || key.endsWith("_text");
}

function scrubValue(value: unknown): { next: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const inner = scrubValue(item);
      if (inner.changed) changed = true;
      return inner.next;
    });
    return { next, changed };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [key, val] of Object.entries(obj)) {
      if (
        deveExpurgarCampo(key) &&
        typeof val === "string" &&
        val !== TEXTO_EXPURGADO
      ) {
        next[key] = TEXTO_EXPURGADO;
        changed = true;
        continue;
      }
      const inner = scrubValue(val);
      next[key] = inner.next;
      if (inner.changed) changed = true;
    }
    return { next, changed };
  }
  return { next: value, changed: false };
}

/**
 * Substitui texto livre do titular em `events` por marcador de expurgo.
 *
 * Não apaga a linha: tipo, motivo e criado_em ficam para o relatório semanal.
 * Casa eventos pelo wa_id_masked — é o identificador que o log de auditoria
 * realmente guarda.
 */
export function scrubUserTextFromEvents(store: Store, waId: string): number {
  const masked = maskPhone(waId);
  const rows = store.db
    .prepare(`SELECT id, payload_json FROM events WHERE payload_json LIKE ?`)
    .all(`%${masked}%`) as Array<{ id: number; payload_json: string }>;

  const update = store.db.prepare(
    `UPDATE events SET payload_json = ? WHERE id = ?`,
  );
  let alteradas = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const { next, changed } = scrubValue(parsed);
    if (!changed) continue;
    update.run(JSON.stringify(next), row.id);
    alteradas += 1;
  }
  return alteradas;
}

/**
 * Marca o aviso de LGPD como entregue.
 *
 * Chamado pelo canal DEPOIS de o envio ter sucesso, nunca pelo agente: se a
 * Graph API falhar, o paciente não viu o aviso e o marcador não pode existir —
 * senão ele nunca mais recebe.
 */
export function marcarAvisoLgpdEntregue(store: Store, waId: string): void {
  marcarAvisoLgpdEnviado(store, waId);
  logEvent(store, "lgpd.aviso_enviado", {
    wa_id_masked: maskPhone(waId),
  });
}

/**
 * Apaga tudo que existe do paciente: mensagens e depois a conversa.
 *
 * A ordem é obrigatória — db.ts liga `foreign_keys = ON` e messages referencia
 * conversations. Tudo numa transação para não deixar mensagem órfã se algo
 * falhar no meio.
 *
 * Agendamento futuro NÃO é apagado: é o compromisso que a clínica assumiu, e a
 * mensagem de confirmação diz exatamente isso ao paciente. O que some é o
 * histórico morto — consultas passadas, canceladas e remarcadas.
 */
export function deleteUserData(
  store: Store,
  waId: string,
  agora?: DateTime,
): DeleteUserDataResult {
  const now = agora ?? DateTime.now();

  const run = store.db.transaction((id: string): DeleteUserDataResult => {
    const agendamentosRemovidos = deletePastAppointments(store, id, now);
    const demandasRemovidas = deleteDemandasByWaId(store, id);
    const eventosExpurgados = scrubUserTextFromEvents(store, id);

    const conv = store.db
      .prepare(`SELECT id FROM conversations WHERE wa_id = ?`)
      .get(id) as { id: number } | undefined;

    if (!conv) {
      return {
        mensagens: 0,
        conversaRemovida: false,
        agendamentosRemovidos,
        demandasRemovidas,
        eventosExpurgados,
      };
    }

    const removed = store.db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .run(conv.id);

    store.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conv.id);

    return {
      mensagens: removed.changes,
      conversaRemovida: true,
      agendamentosRemovidos,
      demandasRemovidas,
      eventosExpurgados,
    };
  });

  return run(waId);
}
