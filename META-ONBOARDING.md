# Meta / WhatsApp — a parte burocrática, por cliente

Consultado na documentação oficial em 17/08/2026. Meta muda esse processo com
frequência; confira as telas antes de prometer prazo a cliente.

---

## A bifurcação que decide tudo

Existem dois modelos, e eles exigem coisas completamente diferentes de você.
Escolher errado custa meses.

### Modelo A — manual, na conta do cliente

Você senta com o dono (ou pega acesso), cria o portfólio de negócios dele,
cria a WABA, cadastra o número, sobe os documentos dele, e pede acesso de
parceiro para você. Tudo na mão, uma vez por cliente.

- **O que você precisa fazer antes:** nada. Nenhuma verificação sua, nenhum
  App Review.
- **Custo por cliente:** 1 a 3 horas suas + a fila da Meta.
- **Teto:** morre por volta do quinto cliente. É exatamente a métrica "tempo de
  setup" do seu handoff.
- É o que a Decisão 5 descreve, e é o certo para o cliente #1.

### Modelo B — Tech Provider com Embedded Signup

Você vira Tech Provider da Meta. Aí o cliente clica um botão no seu site, faz
login com a conta Facebook dele, e uma janela da própria Meta cuida de tudo:
cria portfólio, cria WABA, valida o número por SMS, escolhe o nome de exibição.
No fim, a Meta te devolve o **WABA ID**, o **phone number ID** e um **código de
token** para trocar por um token de acesso.

- **O que você precisa fazer antes:** verificar o *seu* negócio e passar por
  App Review (detalhes abaixo).
- **Custo por cliente:** minutos, e a maior parte é do cliente.
- **Teto inicial:** 10 novos clientes por janela móvel de 7 dias. Com
  Business Verification + App Review + Access Verification, sobe automaticamente
  para 200 por semana.

**Resposta direta à sua pergunta** — "o que precisamos enviar pra Meta pra ela
gerar esse contato": no Modelo B, você não envia nada por cliente. O cliente
passa pela janela da Meta e a Meta te devolve os identificadores. O envio de
documento é dele, na conta dele.

---

## O que você faz UMA vez (Modelo B)

### 1. Verificação do seu negócio

App Dashboard → Use cases → WhatsApp → **Tech Provider onboarding** → Start
verification.

A Meta pede nome do negócio, endereço, telefone, e-mail e **site**. Se ela não
encontrar seu negócio nas bases públicas, pede documento comprobatório.

> O campo **site** costuma travar quem não tem. Vale ter uma página simples no
> ar antes de começar — nome, o que o produto faz, contato e política de
> privacidade. A política de privacidade também é exigida no App Review.

### 2. App Review

Só libera depois da verificação. Você precisa de:

- Ícone do app, categoria e **URL de política de privacidade**
- **Dois vídeos**: (a) uma mensagem sendo criada e enviada pelo seu app e
  recebida no WhatsApp; (b) seu app sendo usado para criar um template

A documentação permite uma alternativa que economiza semanas: em vez do seu app,
você pode gravar **a tela do cURL do API Setup** mandando mensagem para um
número de teste, e **o WhatsApp Manager** criando o template. Ou seja, dá para
passar no App Review antes de ter qualquer painel.

O que você está pedindo são duas permissões em acesso avançado:

- `whatsapp_business_messaging` — enviar mensagem em nome do cliente
- `whatsapp_business_management` — acessar a WABA do cliente. Sem ela, chamadas
  em WABA que não é sua retornam erro 200.

### 3. Testar sem cliente real

App Dashboard → WhatsApp → Quickstart → **Claim sandbox account**. Ele simula um
cliente passando pelo Embedded Signup e devolve WABA ID, phone number ID e o
código de token de verdade. Vale 30 dias, e o número **não envia mensagem** —
serve para validar o fluxo de onboarding, não a conversa.

---

## O que o cliente precisa providenciar (os dois modelos)

Esta é a lista que você manda pro dono da barbearia antes de marcar a conversa.

**Obrigatório:**

1. **Um número de celular que não esteja em uso no WhatsApp comum nem no
   WhatsApp Business.** Se estiver, ele para de funcionar no app ao migrar —
   é a Decisão 2 do seu handoff. Chip novo resolve e custa R$ 10.
2. **Capacidade de receber SMS ou ligação** nesse número, na hora do cadastro.
3. **Conta no Facebook** (dele, não sua) para autenticar.
4. **Nome de exibição** com relação clara com o negócio. "Barbearia do Léo"
   passa; "Atendimento" ou "Agendamento" reprova.
5. **Forma de pagamento na WABA dele.** Como Tech Provider, você não tem linha
   de crédito da Meta — quem paga o consumo é o cliente, direto para a Meta.
   Você fatura só o seu software. Isso é bom: você não vira intermediário
   financeiro nem revendedor de mensagem.

**Para a verificação de negócio dele** (necessária para volume maior e para
mensagem iniciada por template):

- CNPJ ativo
- Documento que confirme razão social e endereço — contrato social, cartão CNPJ,
  conta de luz/água/telefone ou extrato bancário no nome da empresa
- Telefone e e-mail corporativos que a Meta consiga usar para confirmar o vínculo

A tela mostra a lista exata aceita para o Brasil no momento do envio. Não decore.

---

## Sequência e prazos realistas

| Etapa | Quem faz | Prazo |
|---|---|---|
| Verificação do **seu** negócio | você | 2 a 5 dias úteis |
| App Review (Tech Provider) | você | dias a semanas, depende de retrabalho no vídeo |
| Cliente passa pelo Embedded Signup | cliente | minutos |
| Registro do número + código SMS | cliente | minutos |
| Aprovação do **nome de exibição** | Meta | horas a dias |
| Verificação de negócio **do cliente** | cliente | 2 a 5 dias úteis |
| Primeiro template aprovado | Meta | 24 a 48h |

Você consegue **conversar** (mensagem iniciada pelo cliente final, janela de
serviço, gratuita) assim que o número estiver registrado e o nome aprovado. O
que depende da verificação do negócio e de template aprovado é a **mensagem
proativa** — que é exatamente a reocupação de vaga do seu V1, e o lembrete de
24h.

Traduzindo para o seu roadmap: **o V0 inteiro roda sem verificação do cliente.**
Só o V1 depende dela. Isso é melhor do que o handoff assumia.

---

## A consequência arquitetural que ninguém avisa

No Embedded Signup, **todos os webhooks de todos os clientes chegam na mesma URL
de callback do seu app**. Você distingue um do outro pelo `phone_number_id` que
vem no payload.

Seu código hoje é single-tenant: um `CLIENT_CONFIG_PATH`, um YAML, um
`ConfigService` singleton. No Modelo B isso não funciona — você precisa de um
mapa `phone_number_id → config` e de um token por cliente.

Não é um refactor grande (a config já é um objeto tipado; vira um `Map`), mas é
real, e é a razão pela qual a Decisão 6 dizia "um cliente no V0". Dá para adiar
usando **webhook override por WABA ou por número**, que a Meta permite: cada
cliente aponta para uma URL diferente, e você sobe um processo por cliente. Feio
e caro, mas destrava os três primeiros sem tocar no código.

---

## O que eu faria com o CNPJ do seu amigo

**Modelo A para o cliente #1, e a verificação do SEU negócio em paralelo.**

1. **Hoje:** inicie a verificação do seu próprio negócio. Ela roda no relógio da
   Meta e não bloqueia nada do resto. É o caminho crítico do projeto.
2. **Esta semana:** chip novo + WABA do amigo, manual. Nome de exibição
   aprovado. Sem verificação de negócio dele por enquanto — o V0 não precisa.
3. **Enquanto o piloto roda:** App Review usando o atalho do cURL + WhatsApp
   Manager. Você não precisa de painel para passar.
4. **Só depois do terceiro cliente:** Embedded Signup e o refactor multi-tenant.
   Antes disso, é construir plataforma para um problema que ainda não existe.

O CNPJ do amigo resolve o item mais caro da lista — verificação de negócio — mas
repare que ele resolve isso para o **cliente**. A sua verificação, como Tech
Provider, é separada e é a que você deveria começar hoje.

**Uma ressalva sobre usar o CNPJ de um amigo:** o nome de exibição precisa ter
relação clara com o negócio verificado. Se o CNPJ é de uma coisa e você quer
operar uma barbearia fictícia, o nome de exibição reprova. Para teste isso é
irrelevante; para o piloto real, o CNPJ tem que ser o do estabelecimento que
está atendendo.

---

## Custo

Mensagem iniciada pelo cliente final (janela de serviço de 24h) é gratuita —
é 100% do V0. Mensagem iniciada pelo negócio é cobrada por template, por
categoria; utilidade no Brasil ficava na casa de poucos centavos por envio.

**Havia mudanças de preço anunciadas para 1º de agosto e 1º de outubro de 2026.**
A de agosto já passou. Confira a tabela vigente antes de fechar contrato longo
ou precificar a reocupação de vaga.

---

Sources:
- [Embedded Signup — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- [Become a Tech Provider — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [Solution Partner — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview)
