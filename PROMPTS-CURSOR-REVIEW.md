# Prompts de implementação — achados da revisão de 20/08/2026

Ordem de execução. Cada bloco `text` é para copiar inteiro.

**Antes de tudo, fora do Cursor:** a árvore tem 1.339 linhas não commitadas,
incluindo `src/brain/appointments.ts`, `src/store/appointments.ts`,
`src/store/demandas.ts` e `tests/appointments.test.ts`. Commite antes de mexer
em qualquer coisa abaixo — sem isso não há como reverter um prompt que der errado.

```bash
git add -A && git commit -m "feat: cancelamento e remarcação de agendamento"
```

---

## Prompt 1 — P1.1 · Handoff resiliente à falha de notificação

```text
Aja como um engenheiro de confiabilidade responsável por um bot de WhatsApp que atende pacientes de clínica odontológica, onde uma transferência para humano que se perde em silêncio é o pior defeito possível.

# Problema

Em src/brain/handoff.ts:205, transferToHuman faz `await input.notifyHuman(...)` ANTES do logEvent("handoff.transferido") da linha 207. O notifyHuman injetado em src/server.ts é o sendText normal da Graph API — mensagem de texto livre, que a Meta só entrega dentro da janela de 24h desde a última mensagem do destinatário. O número da recepção não conversa com o bot, então essa janela tende a estar fechada e a chamada falha com erro não-retryable.

A falha em cadeia: notifyHuman lança -> logEvent nunca executa -> a exceção sobe até o catch de src/server.ts, que tenta transferToHuman de novo e falha igual. Mas setConversationState(..., "EM_HUMANO", ...) já rodou na linha 194, antes do envio. Resultado em produção: o paciente fica silenciado por 12h (isMutedEmHumano), a recepção nunca é avisada, e nenhum evento handoff.transferido existe no banco — o relatório semanal reporta zero handoffs numa semana em que todos falharam.

Existe ainda src/brain/booking.ts:655, markHandoffState, marcado @deprecated e sem nenhum caller: ele muda o estado para EM_HUMANO sem notificar ninguém e sem gravar evento. Se alguém reusar por engano, reintroduz exatamente este defeito de forma silenciosa.

# Tarefa

- Em transferToHuman, envolver a chamada a notifyHuman em try/catch. O logEvent("handoff.transferido") passa a rodar SEMPRE, com sucesso ou falha do envio, e ganha o campo notificacao_ok: boolean.
- Quando o envio falhar, gravar também logEvent("handoff.notificacao_falhou") com wa_id_masked, motivo do handoff, numero_humano_masked e o erro truncado em 200 caracteres. Não incluir texto do paciente neste evento.
- transferToHuman NUNCA propaga a exceção do notifyHuman: a transferência é considerada bem-sucedida do ponto de vista do paciente, que recebe clientMessage normalmente. Só a notificação falhou.
- Adicionar o campo destino: "paciente" | "humano" ao payload do evento whatsapp.send_failed em src/channel/whatsapp.ts:162 — hoje os dois casos são indistinguíveis, e a gravidade é oposta: falha para o paciente é uma resposta perdida, falha para a recepção é este defeito acontecendo.
- Incluir handoff.notificacao_falhou na contagem de countEventsSince exposta em /health (src/server.ts), como chave própria. Hoje o degradado é invisível.
- Apagar markHandoffState de src/brain/booking.ts e remover o export correspondente de src/brain/index.ts. Confirmar com grep que não há caller.
- Testes: caso em que notifyHuman rejeita e mesmo assim (a) o estado vira EM_HUMANO, (b) handoff.transferido é gravado com notificacao_ok: false, (c) handoff.notificacao_falhou é gravado, (d) transferToHuman resolve sem lançar e devolve clientMessage. Caso de regressão com notifyHuman bem-sucedido gravando notificacao_ok: true. Assert de que o payload de handoff.notificacao_falhou não contém o telefone completo.

Aceite: com a Graph API rejeitando todo envio para o número da recepção, o paciente continua recebendo a mensagem de transferência, o banco registra um handoff.transferido e um handoff.notificacao_falhou por ocorrência, e /health mostra a contagem de notificações falhas da última hora. Nenhum caminho de código chama markHandoffState.
```

> **Decisão que continua aberta e é sua, não do Cursor:** este prompt conserta a
> *visibilidade* da falha, não o canal. Se a recepção usar um WhatsApp Business
> comum que conversa com o bot, a janela de 24h pode estar aberta na prática e o
> defeito muda de "sempre falha" para "falha quando ficam um dia sem interagir".
> Se não conversar, o canal precisa mudar — template aprovado pela Meta, e-mail,
> Telegram ou webhook interno. Decida isso junto com o `META-ONBOARDING.md`,
> depois de rodar este prompt.

---

## Prompt 2 — P1.2 · Exclusão LGPD que apaga o texto do paciente em `events`

```text
Aja como um engenheiro responsável por cumprir, no código, a promessa que o bot faz ao paciente quando ele pede exclusão de dados — num contexto de clínica, onde o texto do paciente é dado de saúde.

# Problema

src/brain/privacy.ts:85, deleteUserData, remove messages, conversations, demandas e agendamentos passados. Não toca na tabela events. Mas events guarda o texto cru do paciente em dois lugares:

- src/brain/handoff.ts:210-211 — o evento handoff.transferido grava `intencao` e `user_text` inteiros
- src/brain/agent.ts:486 — o evento resposta_sem_fonte grava `user_text.slice(0, 280)`

Caminho concreto: o paciente escreve "estou com muita dor no siso, sangrando" -> detectUrgency dispara -> handoff -> o texto vai para events. Ele então envia "excluir meus dados" e recebe a confirmação de que as mensagens e o histórico foram apagados. O texto continua em events por até retencao_dias (180), e continua aparecendo no relatório semanal (src/reports/weekly.ts:152) e no CLI de transcrição (src/reports/transcript.ts:51). A promessa feita ao titular não é cumprida.

O projeto já reconhece a regra: src/channel/whatsapp.ts:228 comenta que "events é log de auditoria, e a mensagem crua do paciente de clínica é dado de saúde", e por isso o inbound_text grava apenas o length. Os dois eventos acima furam essa regra.

# Tarefa

- Em src/brain/privacy.ts, criar scrubUserTextFromEvents(store, waId): number que, para todos os eventos cujo payload_json contenha o wa_id_masked do titular, substitui os campos de texto livre por um marcador de expurgo e devolve quantas linhas foram alteradas. Usar json_set do SQLite ou reserializar em JS, o que ficar mais legível.
- Campos a expurgar: user_text, intencao, texto, e qualquer campo cujo nome termine em _text. Substituir o valor por "[expurgado a pedido do titular]". NÃO apagar a linha do evento: os campos agregados (tipo, motivo, criado_em, contadores) precisam sobreviver para o relatório semanal continuar correto.
- Chamar scrubUserTextFromEvents dentro da MESMA transação de deleteUserData, e incluir eventosExpurgados: number no DeleteUserDataResult.
- Corrigir a origem, para reduzir o problema em vez de só limpar depois: em src/brain/handoff.ts, o evento handoff.transferido passa a gravar user_text truncado em 280 caracteres, igual ao resposta_sem_fonte, em vez do texto inteiro.
- O evento lgpd.exclusao_solicitada passa a registrar eventos_expurgados junto de mensagens_removidas. Continua sem telefone completo e sem qualquer trecho do texto.
- Testes: cenário ponta a ponta — paciente manda uma frase reconhecível, provoca um handoff por urgência, pede exclusão; depois `SELECT payload_json FROM events` não pode conter a frase original, e a contagem de eventos por tipo tem que permanecer a mesma de antes. Caso de que o expurgo não afeta eventos de OUTRO wa_id. Caso de que o relatório semanal continua gerando sem erro após o expurgo.

Aceite: após "excluir meus dados", nenhuma consulta ao banco devolve qualquer trecho do que o paciente escreveu, o relatório semanal continua contando o handoff daquela semana, e os eventos de outros pacientes ficam intactos.
```

---

## Prompt 3 — P1.3 · Serializar turnos do mesmo contato e travar o slot no banco

```text
Aja como um engenheiro de sistemas concorrentes revisando um agente que grava em uma agenda compartilhada, onde criar dois eventos no mesmo horário é o defeito que faz a recepcionista desligar o produto.

# Problema

src/channel/whatsapp.ts:389 responde 200 imediatamente e joga o processamento em setImmediate — correto para não sofrer reentrega da Meta, mas nada serializa dois turnos do mesmo wa_id.

Dois POSTs seguidos do mesmo paciente (ele toca "1" duas vezes; são wa_message_id diferentes, então o dedup por UNIQUE não pega) executam handleUserMessage em paralelo. O turno leva segundos por causa da chamada ao Claude, então a sobreposição é larga. Os dois leem o estado PROPOSTO com os mesmos slots, os dois passam por slotStillFree — o freebusy do Google ainda não reflete o evento que o outro acabou de criar — e os dois chamam createEvent. Resultado: dois eventos na agenda e duas linhas em appointments para o mesmo horário.

Efeitos menores da mesma causa: aviso de LGPD enviado duas vezes, dois handoffs notificados, e lost update no estado_payload, já que todo patchConversationPayload é read-modify-write sem transação.

# Tarefa

Duas camadas. A primeira resolve o caso real de instância única; a segunda é a garantia que sobrevive a restart e a mais de um processo.

- Camada de aplicação, em src/channel/whatsapp.ts: manter um Map<string, Promise<void>> por wa_id e encadear processIncomingMessage nele, de modo que o turno N+1 do mesmo contato só comece quando o turno N terminar. Remover a entrada do Map ao final da cadeia para não vazar memória. Contatos diferentes continuam em paralelo — a serialização é por wa_id, nunca global.
- A cadeia não pode engolir exceção: uma falha no turno N não pode impedir o turno N+1 de rodar. Use um .catch que loga e devolve, mantendo a cadeia viva.
- Camada de banco, criando MIGRATION_V4 em src/store/db.ts seguindo o padrão idempotente das anteriores: índice único parcial em appointments sobre (calendario_id, inicio) restrito a status = 'CONFIRMADO'. Agendamento cancelado ou remarcado não pode bloquear o horário.
- Em src/store/appointments.ts, insertAppointment passa a tratar SQLITE_CONSTRAINT_UNIQUE como colisão de slot e sinalizar isso ao chamador em vez de lançar erro genérico.
- Em src/brain/booking.ts (confirmarAgendamento), a colisão passa a cair no caminho de motivo: "slot_tomado" que já existe — mesma mensagem ao cliente, mesma reproposta. IMPORTANTE: nesse caminho o evento já foi criado no Google Calendar antes do INSERT falhar; ele precisa ser removido com deleteEvent, senão fica órfão na agenda. Se a remoção também falhar, gravar booking.evento_orfao, seguindo o padrão já usado em booking.remarcacao_evento_orfao.
- Testes: unit da cadeia por wa_id provando que duas chamadas concorrentes para o MESMO wa_id executam em sequência (contador de concorrência máxima igual a 1) e que dois wa_id diferentes executam em paralelo. Unit de que uma exceção no primeiro turno não trava o segundo. Integração de que dois confirmarAgendamento concorrentes no mesmo slot produzem exatamente 1 linha CONFIRMADO em appointments e exatamente 1 evento no calendário mockado, com o segundo devolvendo motivo "slot_tomado". Unit de que cancelar um agendamento libera o slot para um novo INSERT.

Aceite: disparar dois webhooks idênticos em conteúdo (ids diferentes) para o mesmo número, no momento da confirmação, produz um único evento no calendário e uma única linha CONFIRMADO; o segundo turno responde que o horário foi ocupado e oferece novos. Nenhum evento órfão fica no Google Calendar.
```

---

## Prompt 4 — P2.5 · "emergência" não aciona o desvio de urgência

```text
Aja como um engenheiro revisando as regras determinísticas de segurança de um bot de clínica odontológica.

# Problema

src/brain/handoff.ts:26 tem o padrão /\bemergenza\b/ — "emergenza" é italiano, aparentemente erro de digitação. A lista URGENCY_PATTERNS cobre "urgencia" e "urgência", mas NÃO cobre "emergência".

Verificado: detectUrgency("tenho uma emergência") e detectUrgency("estou com uma emergencia no dente") retornam false. Numa clínica odontológica, "emergência" é uma das palavras que o paciente mais usa para pedir socorro. Hoje ela cai no caminho normal do modelo em vez do desvio determinístico que transfere na hora sem propor horário.

# Tarefa

- Trocar /\bemergenza\b/ por /\bemergencia\b/. detectUrgency já testa contra o texto normalizado sem acento (normalizeTerm), então uma única entrada cobre "emergência" e "emergencia".
- Revisar a lista inteira pelo mesmo critério e adicionar o que estiver claramente faltando para o vocabulário de um paciente brasileiro em dor: "socorro", "não aguento de dor" / "nao aguento de dor", "dor insuportável" já coberto, "quebrou o dente", "caiu o dente". Não inflar a lista com termos ambíguos — falso positivo aqui transfere gente que não precisava, o que também custa.
- Testes: em tests/handoff.test.ts, casos para "emergência", "emergencia", "tenho uma emergência no dente" e cada termo novo adicionado, todos exigindo detectUrgency true. Casos negativos exigindo false para frases que contenham palavras próximas sem urgência real, por exemplo "vocês atendem emergência aos domingos?" — decida e documente no teste se essa deve transferir (a recomendação é que sim: melhor transferir uma dúvida do que ignorar um pedido de socorro).

Aceite: detectUrgency("tenho uma emergência") retorna true, nenhum padrão em URGENCY_PATTERNS contém palavra de idioma estrangeiro, e a suíte de handoff cobre cada termo da lista com pelo menos um caso.
```

---

## Prompt 5 — P2.4 · Formato de timestamp inconsistente quebra a janela de 6h

```text
Aja como um engenheiro corrigindo um bug de fuso horário que só aparece em produção e que um teste existente esconde.

# Problema

src/store/history.ts:13, hoursBetween, usa Date.parse sobre a coluna messages.timestamp — que guarda DOIS formatos diferentes:

- Mensagem de entrada: ISO com Z, gravado pelo canal em src/channel/whatsapp.ts (new Date(...).toISOString())
- Mensagem de saída: o default do SQLite, datetime('now'), que produz "2026-08-20 13:58:57" — UTC, mas sem marcador de fuso

O V8 interpreta a segunda forma como hora LOCAL. Como a mensagem âncora do cálculo é quase sempre a última resposta do bot (direção out), o intervalo é subestimado exatamente pelo offset local. Em America/Sao_Paulo, o corte de IDLE_HOURS = 6 vira 9h na prática: um paciente que volta 8 horas depois recebe o contexto da conversa anterior em vez de sessão limpa — vazamento de contexto entre atendimentos e resposta baseada em dado velho.

O teste tests/history.test.ts:66 passa porque injeta timestamp ISO também na mensagem out — um formato que a produção nunca gera. É um teste que valida um cenário inexistente.

# Tarefa

- Padronizar a gravação: em src/store/messages.ts, tryInsertMessage passa a usar strftime('%Y-%m-%dT%H:%M:%SZ','now') no lugar de datetime('now') como default do COALESCE, de modo que entrada e saída fiquem no mesmo formato ISO com Z.
- Verificar se outras colunas de tempo comparadas em JS sofrem do mesmo problema — conversations.atualizado_em e events.criado_em usam o mesmo default. Onde forem lidas por Date.parse ou DateTime.fromISO, padronizar igual. Onde forem usadas apenas em comparação SQL entre si (por exemplo o expurgo), NÃO mexer: mudar o formato ali quebraria a comparação com linhas legadas.
- Não migrar dados antigos: o expurgo por retenção cuida das linhas em formato velho. Mas hoursBetween precisa tolerar o formato antigo sem calcular errado — se a string não tiver marcador de fuso, tratar explicitamente como UTC antes de comparar.
- Corrigir o teste: em tests/history.test.ts, a mensagem out passa a ser inserida SEM timestamp explícito, como acontece em produção, para que o default do banco seja exercitado.
- Testes: caso com TZ do processo em America/Sao_Paulo provando que uma conversa com 8h de inatividade real é tratada como sessão nova (histórico limpo), e outra com 5h como sessão contínua. Rodar a suíte com TZ=UTC e TZ=America/Sao_Paulo e exigir resultado idêntico. Caso com uma linha em formato legado ("YYYY-MM-DD HH:MM:SS") provando que é interpretada como UTC.

Aceite: com o processo em America/Sao_Paulo, a janela de 6h corta em 6h e não em 9h; a suíte passa igual em TZ=UTC e TZ=America/Sao_Paulo; e o teste de janela usa o default do banco para a mensagem de saída.
```

---

## Prompt 6 — P2.6 · Teste que tranca o isolamento entre contatos

```text
Aja como um engenheiro de segurança escrevendo o teste de regressão para a regra de autorização mais importante do sistema.

# Problema

O código está correto: cancelar_agendamento e remarcar_agendamento recebem um agendamentoId vindo do modelo, mas resolvem o alvo dentro de listActiveAppointments(store, ctx.waId), então o paciente B não alcança o agendamento do paciente A nem passando o id certo.

O problema é que NENHUM teste prova isso. E agendamentoId é texto que o paciente controla indiretamente por prompt injection — é exatamente a regra que não pode regredir em silêncio numa refatoração futura. Uma mudança inocente que passe a usar getAppointment(store, id) direto, sem o filtro por wa_id, quebraria o isolamento sem quebrar nenhum teste.

# Tarefa

- Em tests/appointments.test.ts, adicionar um describe("isolamento entre contatos") com os casos abaixo.
- Caso 1: criar um agendamento CONFIRMADO para o wa_id A. Chamar cancelarAgendamento no contexto do wa_id B passando o id do agendamento de A. Exigir motivo: "sem_agendamento" (ou o motivo equivalente já existente), que o agendamento de A continue com status CONFIRMADO, e — o assert que mais importa — que calendar.deleteEvent NÃO tenha sido chamado nenhuma vez.
- Caso 2: o mesmo para remarcarAgendamento, exigindo além disso que calendar.createEvent não tenha sido chamado.
- Caso 3: consultar_agendamento no contexto de B não devolve nenhum dado do agendamento de A — nem horário, nem nome, nem profissional.
- Caso 4: id inexistente e id de agendamento já CANCELADO do próprio contato devolvem o mesmo motivo, sem vazar por mensagem de erro diferente se um id existe em outro contato ou simplesmente não existe.
- Usar mocks do calendário com contador de chamadas, no mesmo padrão dos testes já existentes no arquivo.
- Não alterar código de produção neste prompt. Se algum caso falhar, PARE e reporte — significa que existe um furo real de autorização, e ele vira um achado P1 separado.

Aceite: os quatro casos passam sem nenhuma alteração em src/, e trocar propositalmente o listActiveAppointments(store, ctx.waId) por getAppointment(store, id) em src/brain/appointments.ts faz pelo menos dois deles falharem.
```

---

## Prompt 7 — P3 · Endurecer `/health` e fechar a dívida pequena

```text
Aja como um engenheiro de operação preparando o serviço para ficar exposto na internet.

# Problema

src/server.ts:163 expõe /health sem autenticação nenhuma, devolvendo cliente.id, timezone e contadores de erro da última hora. Não é crítico, mas é reconhecimento gratuito para quem alcançar a porta: revela qual cliente está naquele host e se o serviço está degradado.

Além disso, o monitor externo precisa distinguir "processo de pé" de "bot atendendo" — a armadilha já registrada no runbook: token expirado ou webhook desassinado deixam o processo vivo e ninguém é atendido.

# Tarefa

- Dividir em duas rotas: GET /health público, devolvendo apenas { ok: true } e status 200, suficiente para o healthcheck do proxy; e GET /health/detalhe protegido por header Authorization com um token vindo de HEALTH_TOKEN no ambiente, devolvendo o payload atual completo.
- Se HEALTH_TOKEN não estiver definido, /health/detalhe responde 404 — nunca cair para "sem autenticação".
- Comparar o token com timingSafeEqual, no mesmo padrão já usado em verifyWhatsappSignature.
- Acrescentar ao payload detalhado: mensagens recebidas na última hora e na última janela de 12h, para o alerta de "zero mensagens em horário de expediente" descrito em TESTE-LOCAL.md.
- Adicionar HEALTH_TOKEN ao .env.example, comentado.
- Testes: /health sem header responde 200 e não contém cliente.id; /health/detalhe sem header responde 401; com token errado responde 401; com token certo responde 200 com o payload completo; sem HEALTH_TOKEN configurado responde 404.

Aceite: um curl sem credencial na porta do serviço não revela qual cliente está rodando ali, e o monitor externo consegue, com o token, distinguir processo de pé de bot recebendo mensagem.
```

---

## Pontos de vigilância

**Prompt 1** — o Cursor tende a "consertar" o notifyHuman adicionando retry com
backoff. Rejeite: o erro de janela de 24h não é transitório, retry só atrasa a
resposta ao paciente. O que se quer é registrar e seguir.

**Prompt 2** — risco de ele apagar as linhas de `events` inteiras em vez de
expurgar os campos de texto. Isso quebraria o relatório semanal retroativamente
e é pior que o problema original. O teste que exige contagem por tipo inalterada
é o que trava isso.

**Prompt 3** — dois erros prováveis. Primeiro, criar um mutex global em vez de
por `wa_id`, o que serializa clientes diferentes e derruba a vazão. Segundo,
esquecer de remover o evento órfão do Google Calendar quando o INSERT colidir —
aí a agenda fica com um horário ocupado que o sistema não conhece, que é
justamente o pesadelo da recepcionista. O índice único precisa ser **parcial**
(`WHERE status = 'CONFIRMADO'`), senão cancelar e reagendar no mesmo horário
passa a falhar.

**Prompt 5** — ele pode querer migrar os dados antigos "para ficar consistente".
Não vale: é escrita em massa numa tabela que o expurgo esvazia sozinha em 180
dias. O tratamento defensivo em `hoursBetween` cobre o legado.

**Prompt 6** — se algum caso falhar, é achado P1, não teste mal escrito. O
prompt manda parar em vez de ajustar o teste até passar, que é o reflexo errado
mais comum.

**Todos** — o projeto proíbe `Date` nativo para aritmética de tempo; use Luxon
com zone explícita. E rode `npm test` com `TZ=UTC` e `TZ=America/Sao_Paulo`
depois de cada prompt.
