# Prompts para o Cursor — lacunas encontradas na revisão

Ordem importa: P1 destrava o teste local, P2 e P3 são pequenos e independentes,
P4A e P4B são encadeados (P4B depende da coluna criada em P4A).

Cada bloco `text` é para copiar inteiro.

---

## Prompt P1 — Wire do GRAPH_API_BASE no server

```text
[Base]
# Fix: server.ts não repassa GRAPH_API_BASE para o canal do WhatsApp
createWhatsappChannel (src/channel/whatsapp.ts) já aceita graphApiBaseUrl e cai para "https://graph.facebook.com/v21.0" quando ausente, mas src/server.ts não preenche esse campo. Sem ele não é possível apontar o envio para um servidor local de captura em teste.
- Em src/server.ts, na chamada createWhatsappChannel({...}), adicionar: graphApiBaseUrl: process.env.GRAPH_API_BASE
- Não criar variável obrigatória: se GRAPH_API_BASE estiver ausente, o comportamento atual (Graph oficial) deve permanecer idêntico.
- Adicionar GRAPH_API_BASE ao .env.example, comentado, com o valor de exemplo http://localhost:4000 e a nota de que serve só para teste local.
- Testes: em tests/whatsapp.test.ts, garantir que já existe (ou adicionar) caso que instancia o canal com graphApiBaseUrl customizado e verifica que sendText chama a URL customizada; e um caso sem a variável que continua usando graph.facebook.com.
Aceite: subindo com GRAPH_API_BASE=http://localhost:4000, toda chamada de sendText vai para localhost:4000/<phone_number_id>/messages; sem a variável, a URL continua sendo a da Graph oficial e nenhum teste existente quebra.
```

---

## Prompt P2 — Campo `agendavel` no schema de serviços

```text
[Base]
# Feature: serviço não agendável por regra, não por texto de FAQ
Hoje o único freio para agendar um procedimento que exige especialista (canal, extração) é a FAQ em linguagem natural — frágil. src/config/schema.ts (ServicoSchema) e src/brain/booking.ts não têm nenhuma noção de "informo mas não marco".
- Em src/config/schema.ts, adicionar ao ServicoSchema: agendavel: z.boolean().default(true). Default true garante retrocompatibilidade — nenhum YAML existente precisa mudar.
- Em src/brain/booking.ts, no início de proporHorarios: se o serviço resolvido tiver agendavel === false, NÃO consultar o Google Calendar e retornar { ok: false, motivo: "servico_nao_agendavel", mensagem: "<serviço> não é agendado pelo assistente. Informe o cliente de que a recepção monta esse horário e acione acionar_handoff." }.
- Aplicar a mesma checagem no início de confirmarAgendamento, antes de qualquer chamada ao calendário, para o caso de o serviço ter virado não agendável entre a proposta e a confirmação.
- Em src/brain/tools.ts, incluir agendavel no retorno de buscar_servico e listar_servicos, e ajustar a description de propor_horarios para: "Não chame para serviços com agendavel=false — acione acionar_handoff."
- Registrar logEvent(store, "booking.servico_nao_agendavel", { wa_id_masked, servicoId }) para o relatório semanal enxergar a demanda.
- Em clients/clinica-teste.yaml, adicionar os serviços canal (90 min, preco null, agendavel false) e extracao_siso (90 min, preco null, agendavel false), ambos atendidos por dra-ana em profissionais.
- Testes: unit de schema aceitando YAML sem o campo (default true) e com agendavel: false; unit de booking provando que proporHorarios com serviço não agendável NÃO chama calendar.queryBusy (mock com contador de chamadas); regressão de que os serviços agendáveis atuais continuam propondo horários.
Aceite: pedir agendamento de um serviço com agendavel: false devolve handoff sem nenhuma chamada ao Google Calendar, o evento booking.servico_nao_agendavel é gravado, e todos os YAMLs existentes carregam sem alteração.
```

---

## Prompt P3 — Telefone fora do título do evento no Calendar

```text
[Base]
# Fix: minimização de dado — telefone do paciente sai do título do evento
src/brain/booking.ts monta o título como `${servico.nome} — ${nome} (${ctx.waId})` e repete o telefone na description. O título aparece em notificação, visão compartilhada e app móvel de qualquer pessoa com acesso à agenda, o que contraria a minimização declarada no plano do produto (só nome + serviço). A recepção continua precisando do contato, então ele fica só na descrição.
- Em src/brain/booking.ts (confirmarAgendamento), mudar o título para `${servico.nome} — ${nome}`, sem o telefone.
- Manter o telefone completo na description, junto de profissional e origem: "Agendado via WhatsApp.\nTelefone: <waId>\nProfissional: <profissionalNome>". A clínica é a controladora e precisa do contato — a mudança é de exposição, não de coleta.
- Não alterar o payload de logEvent("booking.confirmado"), que já usa telefone mascarado.
- Retrocompatibilidade: eventos já criados no Google Calendar com o formato antigo não devem ser migrados nem reescritos.
- Testes: atualizar o caso existente em tests/booking.test.ts que hoje assere "título com nome/telefone" — passa a exigir que o título contenha nome e serviço e NÃO contenha o número; adicionar assert de que a description contém o telefone.
Aceite: um agendamento novo gera evento com título "Limpeza dental — Daniel Sanoli" sem dígito de telefone, description contendo o número completo, e a suíte de testes verde após a atualização do caso citado.
```

---

## Prompt P4A — LGPD, parte 1: aviso de tratamento de dados

```text
[Base]
# Feature: aviso de LGPD na primeira mensagem de cada paciente
grep -rni "lgpd|excluir|expurgo" src/ não retorna nada: o bot grava conversa de paciente de clínica odontológica (dado de saúde, sensível) sem nenhum aviso de tratamento. Cuidado com a detecção de "primeira mensagem": src/store/history.ts apaga o histórico após 6h de inatividade, então contar mensagens faria o aviso se repetir para sempre. O marcador tem que ser durável, por wa_id.
- Em src/config/schema.ts, criar PrivacidadeSchema { aviso_primeira_mensagem: z.string().min(1), retencao_dias: z.number().int().positive().default(180) } e adicionar privacidade: PrivacidadeSchema ao ClientConfigSchema como campo OBRIGATÓRIO — é requisito legal, não deve ser esquecível por omissão.
- Preencher a chave privacidade em clients/clinica-exemplo.yaml e clients/clinica-teste.yaml com um aviso que diga: quais dados são guardados (nome e procedimento), para quê (atendimento), por quanto tempo, e que existe o comando "excluir meus dados".
- Em src/store/db.ts, seguindo o padrão idempotente de migrateConversations: ALTER TABLE conversations ADD COLUMN aviso_lgpd_em TEXT quando a coluna não existir. Não recriar a tabela.
- Em src/store/conversations.ts, expor precisaEnviarAvisoLgpd(store, waId): boolean e marcarAvisoLgpdEnviado(store, waId): void, operando nessa coluna.
- Em src/brain/agent.ts, dentro de handleUserMessage: se precisaEnviarAvisoLgpd for true, prefixar config.privacidade.aviso_primeira_mensagem à resposta final do turno (separado por uma linha em branco) e marcar como enviado. Vale para TODO turno que produza resposta, inclusive os caminhos que retornam cedo — urgência clínica e gatilho explícito de handoff — porque são justamente os casos em que dado sensível chega primeiro. Não enviar quando o turno for muted.
- Marcar como enviado somente depois de a resposta ser efetivamente devolvida pelo agente, para que uma exceção no meio do turno não faça o paciente perder o aviso.
- logEvent(store, "lgpd.aviso_enviado", { wa_id_masked }).
- Testes: unit provando que o aviso sai uma única vez para o mesmo wa_id mesmo após o histórico ser limpo pela janela de 6h (simular com getConversationWindow/idleHours); que sai no caminho de urgência clínica; que NÃO sai quando isMutedEmHumano é true; e que config sem a chave privacidade falha no boot.
Aceite: o primeiro contato de um número recebe o aviso junto da resposta, o segundo contato não recebe, o mesmo número após 7h de silêncio continua sem receber de novo, e subir com um YAML sem a seção privacidade derruba o processo com erro de configuração.
```

---

## Prompt P4B — LGPD, parte 2: exclusão e expurgo

Depende de P4A (coluna e seção `privacidade` já existentes).

```text
[Base]
# Feature: comando "excluir meus dados" e expurgo por idade
Complementa o aviso de LGPD (P4A) com os dois direitos que ele promete. Atenção à ordem de execução em src/brain/agent.ts: isMutedEmHumano retorna cedo e silencia o turno inteiro por 12h — se a detecção de exclusão ficar depois dele, um paciente em handoff nunca consegue exercer o direito.
- Em src/brain/, criar privacy.ts com detectDeleteRequest(text): boolean, reconhecendo variações normalizadas por normalizeTerm ("excluir meus dados", "apagar meus dados", "apague meus dados", "deletar meus dados", "quero meus dados excluidos"). Reusar normalizeTerm de src/brain/normalize.ts, não reimplementar.
- Em privacy.ts, criar deleteUserData(store, waId): { mensagens: number } que apaga messages e depois conversations do wa_id, numa transação (better-sqlite3 db.transaction). Ordem obrigatória por causa do FOREIGN KEY.
- Em src/brain/agent.ts, checar detectDeleteRequest como PRIMEIRA coisa de handleUserMessage, ANTES de isMutedEmHumano, e responder com uma confirmação curta e explícita de que a conversa foi apagada e de que o agendamento já marcado permanece na agenda da clínica — a clínica é a controladora do compromisso. Não é caso de handoff.
- Ao apagar, gravar logEvent(store, "lgpd.exclusao_solicitada", { wa_id_masked, mensagens_removidas }) — o evento não pode conter o número completo nem o texto das mensagens, senão o expurgo é ilusório.
- Criar src/jobs/purge.ts com purgeOldConversations(store, retencaoDias, now?): remove conversations (e messages em cascata manual) cuja atualizado_em seja mais antiga que retencaoDias, e grava logEvent("lgpd.expurgo", { conversas, mensagens }). Não apagar conversas em estado EM_HUMANO ainda dentro da janela de silêncio.
- Em src/server.ts, agendar purgeOldConversations com setInterval de 24h usando config.privacidade.retencao_dias, e rodar uma vez no boot. Limpar o timer no shutdown, junto do app.close().
- Criar o script npm "expurgo" apontando para um CLI em src/jobs/cli-purge.ts, no mesmo padrão de src/reports/cli-relatorio.ts, para execução manual.
- Testes: unit de detectDeleteRequest com acento, maiúscula e variações; integração provando que a exclusão funciona com a conversa em EM_HUMANO mutada; que o evento logado não contém o telefone completo; e unit de purge com base sintética (uma conversa de 200 dias removida, uma de 10 dias preservada, uma EM_HUMANO recente preservada).
Aceite: um paciente em handoff silenciado que envia "excluir meus dados" recebe confirmação e some das tabelas conversations e messages; npm run expurgo remove conversas acima de retencao_dias e preserva as recentes; e nenhum evento gravado pelo fluxo contém telefone completo.
```

---

## Pontos de vigilância

**P2** — o Cursor tende a filtrar o serviço não agendável só na camada de prompt
(description da ferramenta) e esquecer a checagem em `booking.ts`. Rejeite: a
regra tem que valer mesmo se o modelo chamar a ferramenta errado. O teste com
mock contando chamadas a `queryBusy` é o que prova isso.

**P3** — vai quebrar o teste existente `"evento criado tem duração correta do
serviço e título com nome/telefone"`. Se ele "consertar" reintroduzindo o
telefone no título, rejeite — o teste é que muda.

**P4A** — o erro provável é detectar a primeira mensagem contando linhas em
`messages`. Com a limpeza de 6h de `history.ts`, isso reenvia o aviso para
sempre. Confira que a implementação usa a coluna `aviso_lgpd_em`. O segundo
risco é o aviso não sair nos caminhos de retorno antecipado (urgência e gatilho
explícito), que são exatamente os turnos em que dado sensível aparece primeiro.

**P4B** — o erro grave é colocar `detectDeleteRequest` depois de
`isMutedEmHumano`. Um paciente em handoff ficaria 12h sem conseguir exercer o
direito. Confira também que `deleteUserData` apaga `messages` antes de
`conversations` — `foreign_keys = ON` está ligado em `db.ts` e a ordem inversa
falha.

**Todos** — o projeto usa Luxon com zone explícita e proíbe `Date` nativo para
aritmética. Se aparecer `new Date()` em cálculo de prazo no expurgo, rejeite.
