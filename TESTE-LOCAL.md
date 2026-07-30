# Runbook — testar o V0 localmente

Escrito depois de ler o repositório. Substitui a versão anterior, que foi feita
às cegas e errava env vars, formato de config e comportamento do webhook.

**Não exige:** Meta, número verificado, token da Cloud API, VPS, HTTPS.
**Exige:** as duas agendas do Google compartilhadas com a service account, e a
`ANTHROPIC_API_KEY` (custa centavos).

---

## O que a leitura do repo mudou

Antes de qualquer coisa, o que já está pronto e o que falta.

**Melhor do que o handoff sugeria.** O webhook está correto: HMAC sobre o corpo
bruto (`parseAs: "buffer"` guardando `request.rawBody`), `timingSafeEqual`,
resposta 200 antes de processar via `setImmediate`, e idempotência por
`wa_message_id UNIQUE` no SQLite. `buildSystemPrompt` não contém preço nenhum —
existe até um teste com 20 perguntas de preço como critério de aceite.
`confirmarAgendamento` reconsulta o Calendar (`slotStillFree`) antes de gravar.
E há ~2.400 linhas de teste cobrindo boa parte do plano.

**Duas correções ao que eu escrevi antes:**

1. Assinatura inválida devolve **401**, não 403. O simulador aceita os dois.
2. `graphApiBaseUrl` **já existe** como dependência de `createWhatsappChannel`.
   Falta só `server.ts` preenchê-la a partir do ambiente — uma linha.

**Três lacunas reais, que nenhum teste vai encontrar porque não são bugs:**

| # | Lacuna | Peso |
|---|---|---|
| 1 | **LGPD inexistente.** Nenhum aviso na primeira mensagem, nenhum comando "excluir meus dados", nenhum expurgo de 180 dias. `grep -rni "lgpd\|excluir\|expurgo" src/` não retorna nada. | Bloqueia piloto em clínica — dado de saúde é sensível |
| 2 | **Telefone completo no Google Calendar.** `booking.ts` monta o título como `${servico} — ${nome} (${waId})` e repete o número na descrição. Contradiz a minimização ("só nome + serviço") do próprio plano. | Decisão consciente a tomar, não bug |
| 3 | **Schema sem `agendavel` e sem `exige_avaliacao_previa`.** `canal` tem `preco: null`, mas nada impede o bot de agendá-lo. A FAQ segura isso por texto, o que é frágil. | P2 — vale um campo no schema |

Nada disso impede começar a testar. A lacuna 1 impede vender.

---

## Etapa 0 — Preparação

### 0.1 A única alteração de código

Em `src/server.ts`, na chamada `createWhatsappChannel({...})`, adicione:

```ts
graphApiBaseUrl: process.env.GRAPH_API_BASE,
```

O campo já é opcional na tipagem (`WhatsappChannelDeps.graphApiBaseUrl`) e cai
para `https://graph.facebook.com/v21.0` quando ausente. Sem essa linha, o app
tenta falar com a Meta de verdade e o simulador não enxerga resposta nenhuma.

### 0.2 Google Calendar — **duas** agendas, não uma

`clinica-teste.yaml` tem dois profissionais, cada um com seu calendário. As duas
precisam existir e estar compartilhadas.

1. Google Cloud Console → projeto → **ative a Google Calendar API**. Sem isso
   tudo volta 403 com mensagem que não ajuda.
2. Conta de serviço → chave JSON. O projeto lê **JSON inline** na env
   `GOOGLE_SERVICE_ACCOUNT_JSON`, não caminho de arquivo — atenção ao escapar
   as quebras de linha da private key (`\\n`).
3. No Google Calendar, crie **duas** agendas: `DEV Ana` e `DEV Bruno`.
4. Em cada uma: Configurações → Compartilhar com pessoas específicas → e-mail da
   service account → **"Fazer alterações nos eventos"**.

   > Sem este passo a SA não enxerga nada e o erro parece bug no cálculo de slots.

5. Copie os dois IDs para `GOOGLE_CALENDAR_ANA` e `GOOGLE_CALENDAR_BRUNO`.
6. Confirme que as duas agendas estão em **(GMT-03:00) São Paulo**. Agenda em
   UTC gera 3h de diferença que você vai debugar no lugar errado.

### 0.3 `.env`

O `.env` já existe. Confira que estas estão preenchidas — os nomes são os que o
código realmente lê:

```bash
WA_APP_SECRET=qualquer-string-local          # o simulador assina com a mesma
WA_VERIFY_TOKEN=dev-verify-token
ANTHROPIC_API_KEY=sk-ant-...                 # real
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_CALENDAR_ANA=...@group.calendar.google.com
GOOGLE_CALENDAR_BRUNO=...@group.calendar.google.com
HANDOFF_WHATSAPP=+5511999999999
SQLITE_PATH=./data/chatbot.db

# novas, para o teste local
GRAPH_API_BASE=http://localhost:4000
CLIENT_CONFIG_PATH=./clients/clinica-teste.yaml
```

`WA_APP_SECRET` local pode ser qualquer string. É por isso que a Meta não entra
em nada disto.

`WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_ACCESS_TOKEN` podem ficar com os valores
de exemplo — o simulador captura as chamadas antes de saírem.

### 0.4 Sobe?

```bash
npm run build          # tsc --noEmit
npm run dev
```

Se `clinica-teste.yaml` estiver inválido, o processo **não sobe** — o Zod falha
em `ConfigService.load` e `server.ts` faz `process.exit(1)`. Você acabou de
validar isso de graça.

```bash
curl -i "http://localhost:3000/health"
curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=123"
# esperado: 200 com corpo exatamente "123"
```

### 0.5 Scripts

Adicione ao `package.json`:

```json
"sim": "node tools/sim.mjs",
"sim:sec": "node tools/sim.mjs security",
"sim:all": "node tools/sim.mjs run all"
```

O simulador lê o `.env` sozinho e usa o `better-sqlite3` que já está instalado —
não precisa exportar variável nenhuma no shell.

---

## Etapa 1 — A suíte que já existe

Rode antes de tudo. São 2 segundos e não gastam token.

```bash
npm test
```

Depois o teste que vale por dez — o projeto usa Luxon com zone explícita em todo
lugar, então isto **deve** passar:

```bash
# PowerShell
$env:TZ="UTC"; npm test; $env:TZ="America/Sao_Paulo"; npm test
```

Divergência entre os dois = `Date` nativo em algum caminho. Ache com:

```bash
grep -rn "new Date\|getHours\|setHours" src/calendar/ src/brain/
```

`new Date(Number(timestamp) * 1000)` em `whatsapp.ts` é só para gravar
timestamp de mensagem — aceitável. Em cálculo de slot, não.

Verde aqui, siga. Vermelho, pare: testar conversa com slot errado é debugar dois
problemas ao mesmo tempo.

---

## Etapa 2 — Segurança do webhook

```bash
npm run dev            # terminal 1
npm run sim:sec        # terminal 2
```

Nove verificações objetivas, exit code 1 se falhar. Pela leitura do código, todas
devem passar — este é um teste de confirmação, não de descoberta. Se alguma
falhar, é regressão e você quer saber agora.

A verificação de reentrega leva ~20s: manda o mesmo `wa_message_id` duas vezes e
confere que só uma resposta saiu.

---

## Etapa 3 — Sentir o bot

Cinco minutos antes de rodar cenário em lote:

```bash
npm run sim chat
```

```
paciente > oi
paciente > queria marcar uma limpeza
paciente > /estado
paciente > /reset
paciente > quanto custa restauração?
paciente > /eventos resposta_sem_fonte
paciente > /sair
```

`/estado` mostra o estado da máquina, `/eventos <tipo>` lê a tabela `events`,
`/destravar` encerra o silêncio de 12h sem esperar.

Você nota em dois minutos o que uma suíte levaria uma hora para apontar: resposta
longa demais, tom errado, bot que não pede o nome na hora certa.

---

## Etapa 4 — Os cenários

Comece pelo P1:

```bash
npm run sim run 3.4
```

Cinco tentativas de arrancar o preço da restauração (`preco: null`), incluindo a
pressão social. Regex procura `R$`, números com centavos, faixas e "X reais".
No fim, confere se nasceu algum evento `resposta_sem_fonte`.

Se falhar — improvável, dado `prompt.ts` e `tools.ts` — o vazamento está em
`buscarServico` retornando valor quando `preco_status === "preco_sob_avaliacao"`.

Depois o resto:

```bash
npm run sim run 3.2 3.3 3.5 3.6 3.7 3.8 3.9
npm run sim run 3.10 3.13 3.14 3.15 3.17 3.19 3.21 3.23
# ou
npm run sim:all
```

**Como ler.** As falhas automáticas são objetivas — corrija. O resto o simulador
imprime lado a lado (pergunta, resposta, "esperado") para seu julgamento. Leia
cada uma perguntando *"como paciente, isso me satisfaz ou me irrita?"*.

Dois cenários têm expectativa ajustada à realidade do schema:

- **3.6** (clareamento exige avaliação) só funciona porque está na FAQ. Não há
  campo `exige_avaliacao_previa`. Se ele agendar direto, é limitação conhecida.
- **3.7** (siso/canal) — `canal` existe com `preco: null`, então o handoff vem
  pelo preço, não por "não agendável". Siso não existe na config e cai em
  serviço inexistente.

Depois de 3.10 e 3.17, confirme o registro:

```bash
npm run sim chat
paciente > /eventos demanda_nao_atendida
```

Vazio aqui = 30 dias de piloto sem a matéria-prima da reocupação do V1.

---

## Etapa 5 — Os quatro que o simulador não faz

### 5.1 Agenda duplicada (P1)

O mais importante do runbook, e o único que precisa das duas mãos.

1. `npm run sim chat` → `quero marcar uma limpeza, sou Daniel Sanoli`
2. Recebe os horários. **Não confirme.**
3. No Google Calendar **DEV Ana**, crie um evento à mão ocupando exatamente o
   horário da opção 1.
4. Terminal: `confirmo a opção 1`

**Esperado:** `slotStillFree` retorna false, motivo `slot_tomado`, o bot avisa
com honestidade e repropõe. Nenhum evento criado por cima.

```
paciente > /eventos booking.slot_tomado
```

Se gravar duplicado, o V0 não vai ao ar. É o erro que faz a recepcionista
desligar o bot na primeira semana.

**Variante — expiração.** `PROPOSTO_TTL_MINUTES = 30` e
`RECHECK_AFTER_MINUTES = 15`. Para testar sem esperar, envelheça o `propostoEm`:

```bash
node -e "const D=require('better-sqlite3');const db=new D('./data/chatbot.db');
const r=db.prepare('SELECT estado_payload FROM conversations WHERE wa_id=?').get('5511999990001');
const p=JSON.parse(r.estado_payload); p.propostoEm=new Date(Date.now()-31*60000).toISOString();
db.prepare('UPDATE conversations SET estado_payload=? WHERE wa_id=?').run(JSON.stringify(p),'5511999990001');
console.log('propostoEm envelhecido para 31 min');"
```

Confirme depois disso → esperado `proposta_expirada`, repropõe.

Com 16 minutos (entre 15 e 30) você exercita o outro caminho: o recheck via
`buscarHorarios` com `limite: 100`.

### 5.2 Precedência da equipe (Regra 3)

Edite o horário de um evento criado pelo bot e apague outro, direto no Calendar.
Esperado: nada quebra, as consultas seguintes refletem o novo estado, o bot não
tenta recriar nada.

### 5.3 Fora do expediente

Mande mensagem depois das 19h (ou edite `funcionamento.horario.fim` para uma
hora já passada). Esperado: **agenda normalmente** — é onde está o valor. Só o
handoff usa `handoff.fora_do_horario`, via `isWithinBusinessHours`.

### 5.4 Janela de histórico

`history.ts` mantém 20 mensagens e zera após 6h de inatividade. Vale um teste
manual: converse, envelheça o `timestamp` da última mensagem em 7h, e confirme
que o bot recomeça sem se perder.

---

## Etapa 6 — Fuso de ponta a ponta

```bash
npm run sim run 3.2                       # anote os horários e o evento criado
# derrube o app
$env:TZ="UTC"; npm run dev
npm run sim run 3.2
```

Horários propostos idênticos e evento no mesmo instante real. `slots.ts` usa
`setZone(tz)` em todo lugar, então isto deve passar — é confirmação.

---

## Etapa 7 — Estabilidade e backup

```bash
# .backup, nunca cp
node -e "const D=require('better-sqlite3');new D('./data/chatbot.db').backup('./data/pre-teste.db').then(()=>console.log('ok'))"

# integridade
node -e "const D=require('better-sqlite3');console.log(new D('./data/chatbot.db').pragma('integrity_check'))"

# restauração: sobe em outra porta apontando para o backup
$env:SQLITE_PATH="./data/pre-teste.db"; $env:PORT="3001"; npm run dev
$env:WEBHOOK_URL="http://localhost:3001/webhook"; npm run sim chat
```

Atenção ao WAL: `data/chatbot.db-wal` e `-shm` existem porque o projeto usa
`journal_mode = WAL`. Copiar só o `.db` com `cp` perde transações — é
exatamente a armadilha do handoff.

E teste restart com `PROPOSTO` pendente: peça horários, `Ctrl+C`, `npm run dev`,
confirme. Ou confirma certo, ou repropõe. O que não pode é quebrar.

---

## Etapa 8 — Duas ou três pessoas de fora

O mais barato e mais revelador, e o único que você não faz sozinho. Rode
`npm run sim chat` e **entregue o teclado**, sem instrução além de "marca uma
limpeza aí".

Anote **literalmente** o que escreveram. Alimenta o top-10 de perguntas não
respondidas antes mesmo do piloto.

O que costuma derrubar bot: mensagem quebrada em três partes, typo, duas
perguntas numa frase, resposta a algo que o bot perguntou dois turnos atrás, e
"oi" seguido de silêncio de cinco minutos.

Áudio e foto o simulador cobre parcialmente (cenário 3.23, `UNSUPPORTED_MEDIA_REPLY`);
o comportamento real no aparelho fica para o número de teste da Meta.

---

## Critério de liberação

- [ ] `npm test` verde com `TZ=America/Sao_Paulo` **e** `TZ=UTC`
- [ ] `npm run sim:sec` sem falhas
- [ ] **3.4** — nenhum preço vazado, zero `resposta_sem_fonte`
- [ ] **5.1** — agenda duplicada não acontece
- [ ] Demais cenários com comportamento que você aceitaria como paciente
- [ ] Backup restaurado sobe e responde
- [ ] Três pessoas de fora agendaram sem travar
- [ ] **Decisão tomada sobre LGPD** (ver abaixo)

Os três em negrito são bloqueantes técnicos. O último é bloqueante comercial.

---

## A conversa que o teste não resolve

Passar em tudo isto prova que o código faz o que você mandou. Não prova que o
produto serve, e **não resolve a lacuna de LGPD**.

Vender um bot que grava conversa de paciente em clínica odontológica sem aviso
de tratamento de dados, sem canal de exclusão e sem prazo de expurgo coloca o
risco no seu colo como operador — e o handoff já previa isso na seção 11. São
três coisas pequenas:

1. Aviso na primeira mensagem de cada conversa nova (campo novo no YAML +
   checagem de "é a primeira mensagem?" no `agent.ts`)
2. Comando "excluir meus dados" → apaga `conversations` + `messages` do `wa_id`
3. Job de expurgo por idade

É provavelmente a única coisa que vale construir **antes** do piloto — e ela
passa no filtro da seção 8 do handoff, porque não é feature de produto, é
requisito para poder operar.

---

## Quando algo der errado

| Sintoma | Causa quase sempre |
|---|---|
| Todo slot volta vazio | Calendário não compartilhado com a SA, ou Calendar API não ativada |
| `Falha na subida: configuração inválida` | Env do `${...}` no YAML ausente — `load.ts` exige que exista |
| Simulador não vê resposta | `graphApiBaseUrl` não wired em `server.ts`, ou app não reiniciado |
| Simulador vê o resumo do handoff como "resposta" | Não deveria: ele filtra por `to === número do paciente` |
| Horários com 3h de diferença | Agenda do Google em UTC |
| Bot responde duas vezes | Regressão na unicidade de `wa_message_id` |
| `sim` reclama de better-sqlite3 | `npm rebuild better-sqlite3` |
| Bot mudo no `chat` | Silêncio de 12h ativo — use `/destravar` |
