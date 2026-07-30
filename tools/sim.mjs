#!/usr/bin/env node
/**
 * Simulador de WhatsApp — chatbot-assistente
 * ------------------------------------------
 * Forja payloads da Cloud API, assina como a Meta assina, e bate no webhook
 * local. Mesmo caminho de código da mensagem real; só o transporte é falso.
 * Não precisa de token, número verificado, nem da Meta.
 *
 * Zero dependências além do Node 20+.
 *
 * PRÉ-REQUISITO — uma linha em src/server.ts
 * -------------------------------------------
 * createWhatsappChannel já aceita `graphApiBaseUrl`, mas server.ts não o
 * preenche. Adicione na chamada:
 *
 *     graphApiBaseUrl: process.env.GRAPH_API_BASE,
 *
 * Sem isso o app tenta falar com graph.facebook.com de verdade e o simulador
 * não vê resposta nenhuma.
 *
 * USO
 * ---
 *   node tools/sim.mjs chat        conversa livre no terminal
 *   node tools/sim.mjs list        lista os cenários
 *   node tools/sim.mjs run 3.4     roda um cenário (vários, ou "all")
 *   node tools/sim.mjs security    webhook: assinatura, idempotência, verify
 *   node tools/sim.mjs reset       limpa as conversas de teste
 *
 * Variáveis (lidas do .env do projeto automaticamente):
 *   WA_APP_SECRET   obrigatório
 *   WA_VERIFY_TOKEN usado no modo security
 *   SQLITE_PATH     default ./data/chatbot.db
 *   WEBHOOK_URL     default http://localhost:3000/webhook
 *   CAPTURE_PORT    default 4000
 *   SIM_PHONE       default 5511999990001
 */

import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// .env — mesmo parser do server.ts
// ---------------------------------------------------------------------------

function loadDotEnv(filePath = '.env') {
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) return;
  for (const line of readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://localhost:3000/webhook';
const APP_SECRET = process.env.WA_APP_SECRET ?? '';
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN ?? '';
const PHONE = process.env.SIM_PHONE ?? '5511999990001';
const PHONE_B = '5511999990002';
const CAPTURE_PORT = Number(process.env.CAPTURE_PORT ?? 4000);
const DB_PATH = process.env.SQLITE_PATH ?? './data/chatbot.db';
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS ?? 30000);

if (!APP_SECRET) {
  console.error('\n  WA_APP_SECRET ausente. Confira o .env do projeto.\n');
  process.exit(1);
}

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ---------------------------------------------------------------------------
// SQLite — usa o better-sqlite3 que já está no projeto
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
let db = null;
try {
  const Database = require_('better-sqlite3');
  db = new Database(resolve(DB_PATH));
} catch (e) {
  console.log(`${c.gray}  (sem acesso ao SQLite: ${e.message.split('\n')[0]})${c.reset}`);
}

function reset() {
  if (!db) return false;
  const ids = db.prepare(
    `SELECT id FROM conversations WHERE wa_id IN (?, ?)`).all(PHONE, PHONE_B).map(r => r.id);
  const del = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
  for (const id of ids) del.run(id);
  db.prepare(`DELETE FROM conversations WHERE wa_id IN (?, ?)`).run(PHONE, PHONE_B);
  return true;
}

function estadoAtual(waId = PHONE) {
  if (!db) return null;
  return db.prepare(`SELECT estado, estado_payload FROM conversations WHERE wa_id = ?`).get(waId) ?? null;
}

function eventos(tipo, limite = 10) {
  if (!db) return [];
  return db.prepare(
    `SELECT tipo, payload_json, criado_em FROM events WHERE tipo = ? ORDER BY id DESC LIMIT ?`
  ).all(tipo, limite);
}

/** Encerra o silêncio de 12h sem esperar (usado no cenário 3.13). */
function encerrarSilencio(waId = PHONE) {
  if (!db) return false;
  const row = db.prepare(`SELECT estado_payload FROM conversations WHERE wa_id = ?`).get(waId);
  if (!row) return false;
  const payload = JSON.parse(row.estado_payload || '{}');
  payload.emHumanoDesde = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE conversations SET estado_payload = ? WHERE wa_id = ?`)
    .run(JSON.stringify(payload), waId);
  return true;
}

// ---------------------------------------------------------------------------
// Captura — finge ser a Graph API
// ---------------------------------------------------------------------------

const captured = [];
let captureServer = null;

function startCapture() {
  return new Promise((res) => {
    captureServer = http.createServer((req, resp) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        captured.push({
          at: Date.now(),
          to: body?.to,
          text: body?.text?.body ?? `[não textual: ${raw.slice(0, 100)}]`,
        });
        resp.writeHead(200, { 'Content-Type': 'application/json' });
        resp.end(JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: body?.to, wa_id: body?.to }],
          messages: [{ id: `wamid.SIM.${crypto.randomUUID()}` }],
        }));
      });
    });
    captureServer.listen(CAPTURE_PORT, res);
  });
}
const stopCapture = () => new Promise((r) => (captureServer ? captureServer.close(r) : r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Só respostas ao paciente — ignora o resumo mandado ao número humano. */
async function waitForReply(since, to, timeout = REPLY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  const mine = () => captured.filter((m) => m.at > since && m.to === to);
  while (Date.now() < deadline) {
    if (mine().length) { await sleep(1500); return mine(); }
    await sleep(200);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Payload + assinatura
// ---------------------------------------------------------------------------

function buildPayload(text, { wamid, from = PHONE, name = 'Paciente Teste', type = 'text' } = {}) {
  const message = {
    from,
    id: wamid ?? `wamid.SIM.${crypto.randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === 'text') message.text = { body: text };

  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'SIM_WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '5511300000000', phone_number_id: 'SIM' },
          contacts: [{ profile: { name }, wa_id: from }],
          messages: [message],
        },
      }],
    }],
  };
}

/** A Meta assina os BYTES do corpo, não o JSON re-serializado. */
const sign = (raw, secret = APP_SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

async function post(payload, { signature } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) headers['X-Hub-Signature-256'] = signature ?? sign(raw);
  const t0 = Date.now();
  const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body: raw });
  return { status: res.status, ms: Date.now() - t0, body: await res.text().catch(() => '') };
}

async function send(text, opts = {}) {
  const since = Date.now();
  const from = opts.from ?? PHONE;
  const res = await post(buildPayload(text, { ...opts, from }));
  if (res.status !== 200) return { res, replies: [], erro: `webhook devolveu ${res.status}` };
  if (res.ms > 500) {
    console.log(`${c.yellow}  ! webhook levou ${res.ms}ms para o 200 — a Meta reentrega${c.reset}`);
  }
  return { res, replies: await waitForReply(since, from, opts.timeout) };
}

// ---------------------------------------------------------------------------
// Verificações
// ---------------------------------------------------------------------------

const semPreco = (txt) => {
  const padroes = [/r\$\s*\d/i, /\d+\s*(reais|conto|pila)/i, /\b\d{2,4},\d{2}\b/,
                   /\b\d{3,4}\s*(a|até|ou)\s*\d{3,4}\b/i];
  const hit = padroes.find((p) => p.test(txt));
  return hit ? { ok: false, msg: `contém algo que parece preço: "${txt.match(hit)[0]}"` } : { ok: true };
};
const mudo = (replies) => replies.length === 0
  ? { ok: true } : { ok: false, msg: `respondeu ${replies.length}x durante o silêncio` };
const respondeu = (replies) => replies.length > 0
  ? { ok: true } : { ok: false, msg: 'não respondeu dentro do timeout' };
const contem = (...t) => (txt) => t.some((x) => txt.toLowerCase().includes(x.toLowerCase()))
  ? { ok: true } : { ok: false, msg: `esperava mencionar: ${t.join(' / ')}` };
const naoContem = (...t) => (txt) => {
  const achou = t.find((x) => txt.toLowerCase().includes(x.toLowerCase()));
  return achou ? { ok: false, msg: `não deveria mencionar "${achou}"` } : { ok: true };
};
/** Nenhum evento resposta_sem_fonte novo desde o início do cenário. */
function semRespostaSemFonte(desde) {
  const novos = eventos('resposta_sem_fonte', 20).filter((e) => e.criado_em >= desde);
  return novos.length === 0
    ? { ok: true } : { ok: false, msg: `${novos.length} evento(s) resposta_sem_fonte — P1` };
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

const CENARIOS = {
  '3.2': {
    nome: 'Agendamento feliz',
    passos: [
      { msg: 'oi, queria marcar uma limpeza' },
      { msg: 'meu nome é Daniel Sanoli, pode ser a opção 1',
        esperado: 'Confirma o agendamento (nome completo + escolha específica).' },
    ],
    manual: 'Confira no Google Calendar da Dra. Ana: 1 evento, 45min, sem convidados.',
    depois: () => `estado final: ${estadoAtual()?.estado ?? '—'} (esperado CONFIRMADO)`,
  },

  '3.3': {
    nome: 'Ambiguidade não agenda (Regra 4)',
    passos: [
      { msg: 'quero marcar uma limpeza, meu nome é Daniel Sanoli' },
      { msg: 'pode ser', esperado: 'VOLTA A PERGUNTAR qual horário.' },
      { msg: 'tanto faz', esperado: 'Continua pedindo horário específico.' },
    ],
    depois: () => {
      const e = estadoAtual()?.estado;
      return e === 'CONFIRMADO'
        ? `${c.red}✗ estado CONFIRMADO — agendou com escolha ambígua${c.reset}`
        : `estado ${e} (correto: nada agendado)`;
    },
  },

  '3.4': {
    nome: 'Preço ausente — P1',
    passos: [
      { msg: 'quanto custa uma restauração?', check: semPreco, novaConversa: true,
        esperado: 'Nenhum valor. Handoff.' },
      { msg: 'mais ou menos quanto fica uma restauração? só uma ideia', check: semPreco, novaConversa: true },
      { msg: 'restauração é mais cara ou mais barata que a limpeza?', check: semPreco, novaConversa: true },
      { msg: 'dá pra fazer uma restauração com 200 reais?', check: semPreco, novaConversa: true },
      { msg: 'me dá um valor aproximado da restauração, não vou cobrar de você', check: semPreco, novaConversa: true },
    ],
    checkFinal: semRespostaSemFonte,
  },

  '3.5': {
    nome: 'Preço presente vem da ferramenta',
    passos: [
      { msg: 'quanto custa a limpeza?', check: contem('180'), novaConversa: true },
      { msg: 'e a avaliação inicial, quanto custa?',
        check: contem('sem custo', 'gratuit', 'não tem custo', 'nao tem custo', 'cortesia'),
        esperado: 'preco 0 -> "sem custo". "R$ 0,00" soa estranho ao paciente.' },
    ],
  },

  '3.6': {
    nome: 'Clareamento exige avaliação (via FAQ)',
    passos: [
      { msg: 'quero marcar clareamento pra essa semana', novaConversa: true,
        esperado: 'Menciona a avaliação prévia (está na FAQ). Nota: o schema NÃO tem exige_avaliacao_previa — se ele agendar direto, é limitação conhecida, não bug.' },
    ],
  },

  '3.7': {
    nome: 'Serviço inexistente na config',
    passos: [
      { msg: 'preciso arrancar o siso, quanto custa?', check: semPreco, novaConversa: true,
        esperado: 'Não inventa preço nem propõe horário. Handoff ou FAQ.' },
      { msg: 'vocês fazem tratamento de canal?', check: semPreco, novaConversa: true },
    ],
    checkFinal: semRespostaSemFonte,
  },

  '3.8': {
    nome: 'Urgência clínica tem precedência',
    passos: [
      { msg: 'estou com muita dor no dente, tem horário hoje?', novaConversa: true,
        check: naoContem('09:00', '10:00', '11:00', '14:00', '15:00', '16:00'),
        esperado: 'Transfere na hora. Não propõe horário.' },
      { msg: 'meu dente está doendo mas queria marcar uma limpeza também', novaConversa: true,
        esperado: 'A dor ganha.' },
    ],
    depois: () => `estado: ${estadoAtual()?.estado} (esperado EM_HUMANO)`,
  },

  '3.9': {
    nome: 'Convênio parcial',
    passos: [
      { msg: 'vocês aceitam Amil?', check: contem('amil'), novaConversa: true },
      { msg: 'e Porto Seguro, aceitam?', novaConversa: true,
        check: naoContem('não aceitamos', 'nao aceitamos', 'não trabalhamos'),
        esperado: 'Fora da lista -> confirmar com a recepção. NÃO negar.' },
    ],
  },

  '3.10': {
    nome: 'Bordas de horário',
    passos: [
      { msg: 'tem horário pra limpeza daqui a pouco, hoje?', novaConversa: true,
        esperado: 'Nada nas próximas 3h (antecedencia_minima_horas).' },
      { msg: 'tem horário no domingo pra limpeza?', novaConversa: true,
        esperado: 'Não abre domingo. Deve gerar demanda_nao_atendida.' },
      { msg: 'queria uma limpeza no sábado de manhã', novaConversa: true,
        check: naoContem('12:30', '13:00', '13:30'),
        esperado: 'Sábado fecha 13h. Limpeza 45min + buffer 10min -> último início 12:05.' },
      { msg: 'tem horário pra limpeza no dia 12 de agosto?', novaConversa: true,
        esperado: 'Feriado na config. Não pode propor nada nesse dia.',
        check: naoContem('12/08') },
      { msg: 'pode ser uma limpeza às 13h?', novaConversa: true,
        check: naoContem('13:00', '13h'), esperado: 'Almoço 13–14h.' },
      { msg: 'tem horário pra limpeza em dezembro?', novaConversa: true,
        esperado: 'Fora da janela de 30 dias.' },
      { msg: 'queria marcar uma limpeza pra ontem', novaConversa: true,
        esperado: 'Data no passado, sem quebrar.' },
    ],
    manual: 'Depois: derrube o app, suba com TZ=UTC e rode `run 3.2`. Horários idênticos.',
  },

  '3.13': {
    nome: 'Handoff e silêncio de 12h (Regra 7)',
    passos: [
      { msg: 'quero falar com um atendente', check: respondeu, novaConversa: true },
      { msg: 'oi?', checkReplies: mudo, timeout: 8000, esperado: 'SILÊNCIO.' },
      { msg: 'alguém aí?', checkReplies: mudo, timeout: 8000 },
      { msg: 'quero marcar uma limpeza', checkReplies: mudo, timeout: 8000,
        esperado: 'SILÊNCIO — mensagem que casa com o fluxo não pode reativar o bot.' },
    ],
    depois: () => {
      encerrarSilencio();
      return 'silêncio encerrado à força — mande "oi" no `chat` e o bot deve voltar';
    },
  },

  '3.14': {
    nome: 'Duas falhas seguidas transferem',
    passos: [
      { msg: 'vocês fazem harmonização facial?', novaConversa: true },
      { msg: 'e implante capilar vocês fazem?',
        esperado: 'Segunda falha no mesmo assunto -> transfere.' },
    ],
    depois: () => `estado: ${estadoAtual()?.estado}`,
  },

  '3.15': {
    nome: 'Escape sempre disponível (Regra 2)',
    passos: [
      { msg: 'quero marcar uma limpeza', novaConversa: true },
      { msg: 'na verdade prefiro falar com atendente', check: respondeu,
        esperado: 'Funciona com proposta pendente na tela.' },
    ],
  },

  '3.17': {
    nome: 'Demanda não atendida é registrada',
    passos: [
      { msg: 'queria uma limpeza, mas só posso domingo de manhã', novaConversa: true },
    ],
    checkFinal: (desde) => {
      const novos = eventos('demanda_nao_atendida', 20).filter((e) => e.criado_em >= desde);
      return novos.length > 0 ? { ok: true }
        : { ok: false, msg: 'nenhum demanda_nao_atendida gravado — matéria-prima do V1 perdida' };
    },
  },

  '3.19': {
    nome: 'Isolamento entre conversas',
    passos: [
      { msg: 'quero marcar uma limpeza, sou o Daniel Sanoli', novaConversa: true },
      { msg: 'confirmo a opção 1', from: PHONE_B, name: 'Paciente B',
        check: naoContem('confirmado', 'está marcado', 'agendamento confirmado'),
        esperado: 'B não tem proposta pendente — não pode agendar nada.' },
    ],
    depois: () => `estado de A: ${estadoAtual(PHONE)?.estado} · estado de B: ${estadoAtual(PHONE_B)?.estado}`,
  },

  '3.21': {
    nome: 'Mensagem quebrada em partes + typo',
    passos: [
      { msg: 'oi', novaConversa: true, timeout: 12000 },
      { msg: 'queria marcar', timeout: 12000 },
      { msg: 'uma limpesa', esperado: 'Entende apesar do typo e da quebra em três mensagens.' },
    ],
  },

  '3.23': {
    nome: 'Mídia não suportada',
    passos: [
      { msg: '', type: 'audio', novaConversa: true,
        check: contem('texto'), esperado: 'Responde UNSUPPORTED_MEDIA_REPLY.' },
    ],
  },
};

const MANUAIS = {
  '3.1': 'LGPD: o código NÃO tem aviso de primeira mensagem, comando "excluir meus dados" nem expurgo de 180 dias. Não é bug de teste — é escopo não implementado. Bloqueia o piloto em clínica (dado de saúde é sensível).',
  '3.11': 'Agenda duplicada (P1): rode `chat`, peça limpeza, receba os horários, ocupe o slot À MÃO no Calendar da Dra. Ana, e só então confirme. Esperado: motivo slot_tomado, repropõe, nenhum evento criado.',
  '3.12': 'Precedência da equipe (Regra 3): edite e apague eventos criados pelo bot no Calendar. Esperado: nada quebra.',
  '3.16': 'Fora do expediente: mande mensagem depois das 19h. Esperado: agenda normalmente; só o HANDOFF usa handoff.fora_do_horario.',
  '3.22': 'Estabilidade: restart com PROPOSTO pendente, restauração de backup .backup, PRAGMA integrity_check.',
};

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function agoraSqlite() {
  return new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
}

async function runCenario(id) {
  const cen = CENARIOS[id];
  if (!cen) {
    if (MANUAIS[id]) { console.log(`\n${c.yellow}${c.bold}${id} — manual${c.reset}\n  ${MANUAIS[id]}\n`); return { id, status: 'manual' }; }
    console.log(`${c.red}Cenário ${id} não existe.${c.reset}`);
    return { id, status: 'inexistente' };
  }

  console.log(`\n${c.bold}${c.blue}━━━ ${id} — ${cen.nome} ━━━${c.reset}`);
  const desde = agoraSqlite();
  let falhas = 0;

  for (const passo of cen.passos) {
    if (passo.novaConversa) { reset(); await sleep(300); }
    console.log(`\n${c.cyan}  paciente >${c.reset} ${passo.msg || `[${passo.type}]`}`);

    const { replies, erro } = await send(passo.msg, {
      from: passo.from, name: passo.name, type: passo.type, timeout: passo.timeout,
    });

    if (erro) { console.log(`${c.red}  ✗ ${erro}${c.reset}`); falhas++; continue; }
    if (!replies.length) console.log(`${c.gray}  bot      > (silêncio)${c.reset}`);
    for (const r of replies) {
      console.log(`${c.green}  bot      >${c.reset} ${r.text.replace(/\n/g, '\n             ')}`);
    }
    if (passo.esperado) console.log(`${c.gray}  esperado: ${passo.esperado}${c.reset}`);

    const out = [];
    if (passo.checkReplies) out.push(passo.checkReplies(replies));
    if (passo.check) out.push(passo.check(replies.map((r) => r.text).join('\n')));
    for (const r of out) {
      if (r.ok) console.log(`${c.green}  ✓${c.reset}`);
      else { console.log(`${c.red}${c.bold}  ✗ ${r.msg}${c.reset}`); falhas++; }
    }
  }

  if (cen.checkFinal) {
    const r = cen.checkFinal(desde);
    if (r.ok) console.log(`\n${c.green}  ✓ verificação de eventos${c.reset}`);
    else { console.log(`\n${c.red}${c.bold}  ✗ ${r.msg}${c.reset}`); falhas++; }
  }
  if (cen.depois) console.log(`${c.gray}  ${cen.depois()}${c.reset}`);
  if (cen.manual) console.log(`${c.yellow}  ↳ à mão: ${c.reset}${c.gray}${cen.manual}${c.reset}`);

  console.log(`\n  ${falhas === 0 ? c.green + '✓ sem falhas automáticas' : c.red + `✗ ${falhas} falha(s)`}${c.reset}`);
  return { id, status: falhas === 0 ? 'ok' : 'falhou' };
}

async function runSecurity() {
  console.log(`\n${c.bold}${c.blue}━━━ Segurança do webhook ━━━${c.reset}\n`);
  const r = [];
  const check = (nome, cond, det) => {
    console.log(cond ? `${c.green}  ✓ ${nome}${c.reset}` : `${c.red}${c.bold}  ✗ ${nome} — ${det}${c.reset}`);
    r.push(cond);
  };

  { const before = captured.length;
    const res = await post(buildPayload('quanto custa limpeza'), { signature: null });
    await sleep(2500);
    check('sem assinatura -> 401/403', res.status === 401 || res.status === 403, `devolveu ${res.status}`);
    check('sem assinatura -> nada enviado', captured.length === before,
      'o bot RESPONDEU a payload não assinado'); }

  { const res = await post(buildPayload('oi'), { signature: 'sha256=' + '0'.repeat(64) });
    check('assinatura inválida -> 401/403', res.status === 401 || res.status === 403, `devolveu ${res.status}`); }

  { const p = buildPayload('oi');
    const res = await post(p, { signature: sign(JSON.stringify(p), 'secret-errado') });
    check('secret errado -> 401/403', res.status === 401 || res.status === 403, `devolveu ${res.status}`); }

  { const res = await post(buildPayload('oi'));
    check('assinatura válida -> 200', res.status === 200,
      `devolveu ${res.status} — HMAC provavelmente calculado sobre JSON re-serializado`);
    check('200 antes de processar (<500ms)', res.ms < 500, `levou ${res.ms}ms`);
    await sleep(3000); }

  if (VERIFY_TOKEN) {
    const bad = await fetch(`${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123`);
    check('GET verify_token errado -> 403', bad.status === 403, `devolveu ${bad.status}`);
    const good = await fetch(`${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=123`);
    const body = await good.text();
    check('GET verify_token certo -> 200 + challenge', good.status === 200 && body.trim() === '123',
      `status ${good.status}, corpo "${body.slice(0, 30)}"`);
  } else {
    console.log(`${c.gray}  (WA_VERIFY_TOKEN ausente — pulei a verificação GET)${c.reset}`);
  }

  { reset(); await sleep(300);
    const wamid = `wamid.SIM.REPLAY.${crypto.randomUUID()}`;
    const before = captured.length;
    await post(buildPayload('quanto custa a limpeza?', { wamid }));
    await sleep(9000);
    const primeira = captured.length - before;
    await post(buildPayload('quanto custa a limpeza?', { wamid }));
    await sleep(9000);
    const total = captured.length - before;
    check('reentrega com mesmo wamid não duplica', total === primeira,
      `${total} mensagens no total, ${primeira} na primeira entrega`); }

  { const st = await post({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] });
    check('payload de status -> 200 ignorado', st.status === 200, `devolveu ${st.status}`);
    const lixo = await post({ foo: 'bar' });
    check('payload malformado -> 200, não 500', lixo.status === 200,
      `devolveu ${lixo.status} — 500 faz a Meta reentregar em loop`); }

  const falhas = r.filter((x) => !x).length;
  console.log(`\n  ${falhas === 0 ? c.green + '✓ passou' : c.red + c.bold + `✗ ${falhas} falha(s) — o V0 não vai ao ar assim`}${c.reset}\n`);
  return falhas;
}

async function runChat() {
  console.log(`\n${c.bold}chat${c.reset} ${c.gray}· ${WEBHOOK_URL} · captura :${CAPTURE_PORT} · ${PHONE}${c.reset}`);
  console.log(`${c.gray}/reset  /estado  /eventos <tipo>  /destravar  /quem <num>  /sair${c.reset}\n`);
  let from = PHONE;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((r) => rl.question(`${c.cyan}paciente > ${c.reset}`, r));

  for (;;) {
    const l = (await ask()).trim();
    if (!l) continue;
    if (l === '/sair') break;
    if (l === '/reset') { reset(); console.log(`${c.gray}limpo${c.reset}`); continue; }
    if (l === '/estado') { console.log(`${c.gray}${JSON.stringify(estadoAtual(from))}${c.reset}`); continue; }
    if (l === '/destravar') { encerrarSilencio(from); console.log(`${c.gray}silêncio encerrado${c.reset}`); continue; }
    if (l.startsWith('/eventos ')) {
      for (const e of eventos(l.slice(9).trim(), 5)) console.log(`${c.gray}${e.criado_em} ${e.payload_json.slice(0, 160)}${c.reset}`);
      continue;
    }
    if (l.startsWith('/quem ')) { from = l.slice(6).trim(); console.log(`${c.gray}agora ${from}${c.reset}`); continue; }

    const { replies, erro } = await send(l, { from });
    if (erro) { console.log(`${c.red}  ✗ ${erro}${c.reset}`); continue; }
    if (!replies.length) console.log(`${c.gray}bot      > (silêncio — handoff ativo? use /destravar)${c.reset}`);
    for (const r of replies) console.log(`${c.green}bot      >${c.reset} ${r.text.replace(/\n/g, '\n           ')}`);
  }
  rl.close();
}

function list() {
  console.log(`\n${c.bold}Automatizáveis${c.reset}`);
  for (const [id, cen] of Object.entries(CENARIOS)) console.log(`  ${c.cyan}${id.padEnd(6)}${c.reset} ${cen.nome}`);
  console.log(`\n${c.bold}Só manuais${c.reset}`);
  for (const [id, t] of Object.entries(MANUAIS)) console.log(`  ${c.yellow}${id.padEnd(6)}${c.reset} ${t.split(':')[0]}`);
  console.log();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') { list(); return; }
  if (cmd === 'list') return list();
  if (cmd === 'reset') { console.log(reset() ? 'ok' : 'falhou'); return; }

  await startCapture();
  try {
    if (cmd === 'chat') await runChat();
    else if (cmd === 'security') process.exitCode = (await runSecurity()) > 0 ? 1 : 0;
    else if (cmd === 'run') {
      const ids = args[0] === 'all' ? Object.keys(CENARIOS) : args;
      const out = [];
      for (const id of ids) out.push(await runCenario(id));
      console.log(`\n${c.bold}━━━ Resumo ━━━${c.reset}`);
      for (const r of out) {
        const cor = r.status === 'ok' ? c.green : r.status === 'falhou' ? c.red : c.yellow;
        console.log(`  ${cor}${r.status.padEnd(7)}${c.reset} ${r.id.padEnd(6)} ${CENARIOS[r.id]?.nome ?? ''}`);
      }
      console.log(`\n${c.gray}  Falhas automáticas são objetivas. O resto exige seu julgamento.${c.reset}\n`);
      if (out.some((r) => r.status === 'falhou')) process.exitCode = 1;
    } else console.log(`Comando desconhecido: ${cmd}`);
  } finally {
    await stopCapture();
    db?.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
