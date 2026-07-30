import type { Store } from "../store/index.js";
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
  "Se você já tinha um horário marcado, ele continua na agenda da clínica — para desmarcar, é só pedir por aqui e a recepção resolve.",
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
};

/**
 * Apaga tudo que existe do paciente: mensagens e depois a conversa.
 *
 * A ordem é obrigatória — db.ts liga `foreign_keys = ON` e messages referencia
 * conversations. Tudo numa transação para não deixar mensagem órfã se algo
 * falhar no meio.
 */
export function deleteUserData(store: Store, waId: string): DeleteUserDataResult {
  const run = store.db.transaction((id: string): DeleteUserDataResult => {
    const conv = store.db
      .prepare(`SELECT id FROM conversations WHERE wa_id = ?`)
      .get(id) as { id: number } | undefined;

    if (!conv) {
      return { mensagens: 0, conversaRemovida: false };
    }

    const removed = store.db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .run(conv.id);

    store.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conv.id);

    return { mensagens: removed.changes, conversaRemovida: true };
  });

  return run(waId);
}
