import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { maskPhone } from "../src/channel/mask.js";
import { buildDayTranscript } from "../src/reports/transcript.js";
import {
  computeWeeklyReport,
  formatWeeklyReportText,
} from "../src/reports/weekly.js";
import {
  openStore,
  tryInsertMessage,
  upsertConversation,
  type Store,
} from "../src/store/index.js";

const dirs: string[] = [];
const stores: Store[] = [];
const TZ = "America/Sao_Paulo";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reports-"));
  dirs.push(dir);
  const store = openStore(join(dir, "t.db"));
  stores.push(store);
  return store;
}

function seedMessage(
  store: Store,
  waId: string,
  direcao: "in" | "out",
  texto: string,
  timestamp: string,
  estado = "LIVRE",
): void {
  const conversationId = upsertConversation(store, waId);
  store.db
    .prepare(`UPDATE conversations SET estado = ? WHERE id = ?`)
    .run(estado, conversationId);
  tryInsertMessage(store, {
    conversationId,
    direcao,
    texto,
    waMessageId: `${waId}-${direcao}-${timestamp}-${Math.random()}`,
    timestamp,
  });
}

function seedEvent(
  store: Store,
  tipo: string,
  payload: Record<string, unknown>,
  criadoEm: string,
): void {
  store.db
    .prepare(
      `INSERT INTO events (tipo, payload_json, criado_em) VALUES (?, ?, ?)`,
    )
    .run(tipo, JSON.stringify(payload), criadoEm);
}

describe("relatório semanal", () => {
  it("retorna contagens corretas com base sintética", () => {
    const store = setupStore();
    // Semana de 2026-07-27 (segunda) a 2026-08-02 (domingo)
    const t1 = "2026-07-28T10:00:00.000Z";
    const t1b = "2026-07-28T10:00:05.000Z";
    const t2 = "2026-07-29T11:00:00.000Z";
    const t2b = "2026-07-29T11:00:10.000Z";
    const t3 = "2026-07-30T12:00:00.000Z";
    const t3b = "2026-07-30T12:00:08.000Z";

    // Conv A: contida + agendamento
    seedMessage(store, "5511111111111", "in", "quero limpeza", t1);
    seedMessage(store, "5511111111111", "out", "horários...", t1b);
    seedEvent(store, "booking.confirmado", {
      wa_id_masked: maskPhone("5511111111111"),
      duracao_min: 45,
    }, t1b);

    // Conv B: handoff desconhecimento
    seedMessage(store, "5511222222222", "in", "vocês fazem implante?", t2);
    seedMessage(store, "5511222222222", "out", "vou transferir", t2b, "EM_HUMANO");
    seedEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone("5511222222222"),
      motivo: "servico_inexistente",
      user_text: "vocês fazem implante?",
      intencao: "implante",
    }, t2b);

    // Conv C: handoff reclamação + demanda
    seedMessage(store, "5511333333333", "in", "quero reclamar", t3);
    seedMessage(store, "5511333333333", "out", "transferindo", t3b, "EM_HUMANO");
    seedEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone("5511333333333"),
      motivo: "reclamacao",
      user_text: "quero reclamar",
    }, t3b);
    seedEvent(store, "demanda_nao_atendida", {
      telefone: "5511333333333",
      servicoId: "limpeza",
      janela_desejada: "domingo",
      timestamp: t3,
    }, t3);
    seedEvent(store, "demanda_nao_atendida", {
      telefone: "5511444444444",
      servicoId: "limpeza",
      janela_desejada: "noite",
      timestamp: t3b,
    }, t3b);
    seedEvent(store, "demanda_nao_atendida", {
      telefone: "5511555555555",
      servicoId: "canal",
      janela_desejada: "sabado",
      timestamp: t3b,
    }, t3b);

    // Incidente
    seedEvent(store, "resposta_sem_fonte", {
      wa_id_masked: maskPhone("5511111111111"),
      user_text: "oi",
    }, t1b);

    const ref = DateTime.fromISO("2026-07-28", { zone: TZ });
    const data = computeWeeklyReport(store, ref);

    expect(data.conversasAtendidas).toBe(3);
    expect(data.agendamentosConcluidos).toBe(1);
    expect(data.conversasComHandoff).toBe(2);
    expect(data.conversasContidas).toBe(1);
    expect(data.taxaContencao).toBeCloseTo(1 / 3, 5);
    expect(data.demandaPorServico).toEqual([
      { servicoId: "limpeza", count: 2 },
      { servicoId: "canal", count: 1 },
    ]);
    expect(data.handoffMotivos[0]?.motivo).toBeDefined();
    expect(data.perguntasDesconhecimento).toHaveLength(1);
    expect(data.perguntasDesconhecimento[0]?.pergunta).toContain("implante");
    expect(data.tempoMedioPrimeiraRespostaSeg).toBeCloseTo(
      (5 + 10 + 8) / 3,
      5,
    );
  });

  it("conta cancelamento, remarcação e agenda devolvida", () => {
    const store = setupStore();
    const t = "2026-07-28T10:00:00.000Z";
    seedMessage(store, "5511111111111", "in", "quero desmarcar", t);
    seedMessage(store, "5511111111111", "out", "cancelado", t);

    seedEvent(store, "booking.cancelado", {
      wa_id_masked: maskPhone("5511111111111"),
      duracao_min: 45,
    }, t);
    seedEvent(store, "booking.cancelado", {
      wa_id_masked: maskPhone("5511222222222"),
      duracao_min: 90,
    }, t);
    seedEvent(store, "booking.remarcado", {
      wa_id_masked: maskPhone("5511333333333"),
    }, t);
    seedEvent(store, "booking.cancelamento_tardio", {
      wa_id_masked: maskPhone("5511444444444"),
      horas_ate: 2,
    }, t);
    seedEvent(store, "booking.remarcacao_evento_orfao", {
      wa_id_masked: maskPhone("5511555555555"),
      event_id_antigo: "evt-9",
      inicio_antigo: "2026-07-30T09:00:00-03:00",
    }, t);

    const data = computeWeeklyReport(
      store,
      DateTime.fromISO("2026-07-28", { zone: TZ }),
    );

    expect(data.cancelamentosAutonomos).toBe(2);
    expect(data.minutosLiberados).toBe(135);
    expect(data.remarcacoesConcluidas).toBe(1);
    // Remarcação não é agendamento novo — não pode inflar o número de vendas.
    expect(data.agendamentosConcluidos).toBe(0);
    expect(data.cancelamentosEmCimaDaHora).toBe(1);
    expect(data.eventosOrfaos).toHaveLength(1);

    const texto = formatWeeklyReportText(data);
    expect(texto).toContain("2.3h de agenda devolvidas");
    expect(texto).toContain("Eventos a limpar na agenda");
    expect(texto).toContain("evt-9");
  });

  it("contenção calcula certo com conversas mistas", () => {
    const store = setupStore();
    const base = "2026-07-28T15:00:00.000Z";

    for (let i = 0; i < 4; i++) {
      const wa = `55110000000${i}`;
      seedMessage(store, wa, "in", "oi", base);
      seedMessage(store, wa, "out", "olá", "2026-07-28T15:00:02.000Z");
    }
    // 1 handoff em 4 conversas → contenção 75%
    seedEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone("551100000000"),
      motivo: "gatilho_explicito:atendente",
      user_text: "quero atendente",
    }, base);

    const data = computeWeeklyReport(
      store,
      DateTime.fromISO("2026-07-28", { zone: TZ }),
    );
    expect(data.conversasAtendidas).toBe(4);
    expect(data.conversasComHandoff).toBe(1);
    expect(data.conversasContidas).toBe(3);
    expect(data.taxaContencao).toBeCloseTo(0.75, 5);
  });

  it("resposta_sem_fonte aparece destacada no topo do relatório", () => {
    const store = setupStore();
    seedMessage(store, "5511999887766", "in", "ajuda", "2026-07-28T09:00:00.000Z");
    seedMessage(
      store,
      "5511999887766",
      "out",
      "ok",
      "2026-07-28T09:00:01.000Z",
    );
    seedEvent(store, "resposta_sem_fonte", {
      wa_id_masked: maskPhone("5511999887766"),
      user_text: "qual o preço secreto?",
    }, "2026-07-28T09:00:01.000Z");

    const data = computeWeeklyReport(
      store,
      DateTime.fromISO("2026-07-28", { zone: TZ }),
    );
    const text = formatWeeklyReportText(data);

    expect(data.respostaSemFonte).toHaveLength(1);
    expect(text.indexOf("ALERTA DE RISCO")).toBeLessThan(text.indexOf("## Resumo"));
    expect(text).toContain("incidente(s)");
    expect(text).toContain("qual o preço secreto?");
    expect(text).toMatch(/\*\*\*\*\d{4}/);
  });
});

describe("transcrição do dia", () => {
  it("imprime conversa legível com ferramentas e handoff", () => {
    const store = setupStore();
    const wa = "5511888777666";
    seedMessage(store, wa, "in", "quanto custa limpeza", "2026-08-03T13:00:00.000Z");
    seedMessage(store, wa, "out", "R$ 180", "2026-08-03T13:00:02.000Z");
    seedEvent(store, "brain.turno", {
      wa_id_masked: maskPhone(wa),
      ferramentas: ["buscar_servico"],
      handoff: false,
      resposta_sem_fonte: false,
    }, "2026-08-03T13:00:02.000Z");
    seedEvent(store, "handoff.transferido", {
      wa_id_masked: maskPhone(wa),
      motivo: "reclamacao",
      intencao: "reclamar depois",
    }, "2026-08-03T13:05:00.000Z");

    const text = buildDayTranscript(store, "2026-08-03", "UTC");
    expect(text).toContain(wa); // transcrição mostra completo
    expect(text).toContain("CLIENTE: quanto custa limpeza");
    expect(text).toContain("buscar_servico");
    expect(text).toContain("Motivo final de handoff: reclamacao");
  });
});
