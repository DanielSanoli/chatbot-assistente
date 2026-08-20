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

export type DeleteUserDataResult = {
  /** Mensagens removidas. 0 se o wa_id não existia. */
  mensagens: number;
  /** True se havia uma conversa registrada para o wa_id. */
  conversaRemovida: boolean;
  /** Agendamentos passados/cancelados removidos. Os futuros são preservados. */
  agendamentosRemovidos: number;
  /** Linhas da fila de retorno removidas (guardam telefone completo). */
  demandasRemovidas: number;
};

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

    const conv = store.db
      .prepare(`SELECT id FROM conversations WHERE wa_id = ?`)
      .get(id) as { id: number } | undefined;

    if (!conv) {
      return {
        mensagens: 0,
        conversaRemovida: false,
        agendamentosRemovidos,
        demandasRemovidas,
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
    };
  });

  return run(waId);
}
