import type { ClientConfig, Servico } from "../config/schema.js";
import type { CalendarClient } from "../calendar/google.js";
import type { Store } from "../store/index.js";
import { DateTime } from "luxon";
import { normalizeTerm } from "./normalize.js";
import {
  confirmarAgendamento,
  proporHorarios,
  type BookingContext,
} from "./booking.js";
import {
  matchTemaSempreHumano,
  registerUnderstandingFailure,
  transferToHuman,
} from "./handoff.js";

export const PRECO_SOB_AVALIACAO = "preco_sob_avaliacao" as const;

export type ToolName =
  | "buscar_servico"
  | "listar_servicos"
  | "info_local"
  | "info_pagamento"
  | "buscar_faq"
  | "acionar_handoff"
  | "registrar_falha_entendimento"
  | "propor_horarios"
  | "confirmar_agendamento";

export type ToolContext = {
  config: ClientConfig;
  store: Store;
  calendar: CalendarClient;
  waId: string;
  agora?: DateTime;
  userText?: string;
  notifyHuman: (numeroHumano: string, resumo: string) => Promise<void>;
};

export type BuscarServicoResult =
  | {
      encontrado: true;
      id: string;
      nome: string;
      duracao_min: number;
      preco: number | null;
      preco_status: "informado" | typeof PRECO_SOB_AVALIACAO;
      marcador?: typeof PRECO_SOB_AVALIACAO;
      agendavel: boolean;
    }
  | {
      encontrado: false;
      termo: string;
      mensagem: string;
    };

function matchServico(servicos: Servico[], termo: string): Servico | null {
  const needle = normalizeTerm(termo);
  if (!needle) return null;

  for (const servico of servicos) {
    const candidates = [
      servico.id,
      servico.nome,
      ...servico.aliases,
    ].map(normalizeTerm);

    if (candidates.some((c) => c === needle || c.includes(needle) || needle.includes(c))) {
      return servico;
    }
  }

  return null;
}

export function buscarServico(
  config: ClientConfig,
  termo: string,
): BuscarServicoResult {
  const servico = matchServico(config.servicos, termo);
  if (!servico) {
    return {
      encontrado: false,
      termo,
      mensagem:
        "Serviço não encontrado na configuração. Não invente. Acione handoff.",
    };
  }

  if (servico.preco === null) {
    return {
      encontrado: true,
      id: servico.id,
      nome: servico.nome,
      duracao_min: servico.duracao_min,
      preco: null,
      preco_status: PRECO_SOB_AVALIACAO,
      marcador: PRECO_SOB_AVALIACAO,
      agendavel: servico.agendavel,
    };
  }

  return {
    encontrado: true,
    id: servico.id,
    nome: servico.nome,
    duracao_min: servico.duracao_min,
    preco: servico.preco,
    preco_status: "informado",
    agendavel: servico.agendavel,
  };
}

export function listarServicos(config: ClientConfig) {
  return {
    servicos: config.servicos.map((s) => ({
      id: s.id,
      nome: s.nome,
      aliases: s.aliases,
      agendavel: s.agendavel,
    })),
  };
}

export function infoLocal(config: ClientConfig) {
  const { local } = config;
  return {
    endereco: local.endereco,
    bairro: local.bairro ?? null,
    cidade: local.cidade,
    estado: local.estado,
    cep: local.cep ?? null,
    complemento: local.complemento ?? null,
    referencia: local.referencia ?? null,
    estacionamento: local.estacionamento ?? null,
  };
}

export function infoPagamento(config: ClientConfig) {
  return {
    formas: config.pagamento.formas,
    instrucoes: config.pagamento.instrucoes,
  };
}

export function buscarFaq(config: ClientConfig, assunto: string) {
  const needle = normalizeTerm(assunto);
  const hits = config.faq.filter((item) => {
    const blob = normalizeTerm(`${item.pergunta} ${item.resposta}`);
    return blob.includes(needle) || needle.split(/\s+/).some((w) => w && blob.includes(w));
  });

  return {
    encontrados: hits.length,
    itens: hits,
  };
}

function toBookingContext(ctx: ToolContext): BookingContext {
  return {
    store: ctx.store,
    config: ctx.config,
    calendar: ctx.calendar,
    waId: ctx.waId,
    agora: ctx.agora,
    userText: ctx.userText,
  };
}

export async function executeTool(
  ctx: ToolContext,
  name: ToolName,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "buscar_servico":
      return buscarServico(ctx.config, String(input.termo ?? ""));
    case "listar_servicos":
      return listarServicos(ctx.config);
    case "info_local":
      return infoLocal(ctx.config);
    case "info_pagamento":
      return infoPagamento(ctx.config);
    case "buscar_faq":
      return buscarFaq(ctx.config, String(input.assunto ?? ""));
    case "acionar_handoff": {
      const motivo = String(input.motivo ?? "nao_informado");
      const tema = matchTemaSempreHumano(
        motivo,
        ctx.config.handoff.temas_sempre_humano,
      );
      const transfer = await transferToHuman({
        store: ctx.store,
        config: ctx.config,
        waId: ctx.waId,
        motivo: tema ?? motivo,
        intencao:
          input.intencao !== undefined
            ? String(input.intencao)
            : ctx.userText,
        userText: ctx.userText,
        agora: ctx.agora,
        notifyHuman: ctx.notifyHuman,
      });
      return {
        handoff: true as const,
        motivo: transfer.motivo,
        mensagem: transfer.clientMessage,
        resumo_humano: transfer.humanSummary,
        numero_humano: transfer.numeroHumano,
        estado: transfer.estado,
      };
    }
    case "registrar_falha_entendimento": {
      const assunto = String(input.assunto ?? ctx.userText ?? "geral");
      const falha = registerUnderstandingFailure(ctx.store, ctx.waId, assunto);
      if (falha.deveTransferir) {
        const transfer = await transferToHuman({
          store: ctx.store,
          config: ctx.config,
          waId: ctx.waId,
          motivo: "falha_entendimento",
          intencao: assunto,
          userText: ctx.userText,
          agora: ctx.agora,
          notifyHuman: ctx.notifyHuman,
        });
        return {
          handoff: true as const,
          count: falha.count,
          deveTransferir: true,
          motivo: "falha_entendimento",
          mensagem: transfer.clientMessage,
          resumo_humano: transfer.humanSummary,
        };
      }
      return {
        handoff: false as const,
        count: falha.count,
        deveTransferir: false,
        mensagem:
          "Falha registrada. Peça esclarecimento uma vez. Na próxima falha no mesmo assunto, transfira.",
      };
    }
    case "propor_horarios":
      return proporHorarios(toBookingContext(ctx), {
        servicoId: String(input.servicoId ?? ""),
        preferencia:
          input.preferencia !== undefined
            ? String(input.preferencia)
            : undefined,
      });
    case "confirmar_agendamento":
      return confirmarAgendamento(toBookingContext(ctx), {
        slotEscolhido: String(input.slotEscolhido ?? ""),
        nomeCompleto: String(input.nomeCompleto ?? ""),
      });
    default: {
      const _exhaustive: never = name;
      return { erro: `ferramenta desconhecida: ${_exhaustive}` };
    }
  }
}

export const ANTHROPIC_TOOLS = [
  {
    name: "buscar_servico",
    description:
      "Busca um serviço pelo nome, id ou alias. Use SEMPRE antes de falar de preço ou duração. Se preco_status for preco_sob_avaliacao, acione handoff sem informar valor.",
    input_schema: {
      type: "object" as const,
      properties: {
        termo: {
          type: "string",
          description: "Nome, id ou alias do serviço (ex.: limpeza, tártaro, canal)",
        },
      },
      required: ["termo"],
    },
  },
  {
    name: "listar_servicos",
    description:
      "Lista os serviços oferecidos (sem preços). Para preço/duração de um item, use buscar_servico.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "info_local",
    description:
      "Retorna endereço, referência e estacionamento. Use antes de responder sobre localização ou estacionamento.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "info_pagamento",
    description:
      "Retorna formas de pagamento e instruções (inclui convênio se houver). Use antes de falar de pagamento ou convênio.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "buscar_faq",
    description: "Busca respostas na FAQ do cliente por assunto.",
    input_schema: {
      type: "object" as const,
      properties: {
        assunto: { type: "string", description: "Assunto da dúvida" },
      },
      required: ["assunto"],
    },
  },
  {
    name: "propor_horarios",
    description:
      "Propõe 2–3 horários livres para um serviço (lê a agenda). Use quando o cliente quiser agendar. Nunca invente horários. Não chame para serviços com agendavel=false — acione acionar_handoff. NÃO use se houver urgência clínica (dor forte, sangramento, inchaço).",
    input_schema: {
      type: "object" as const,
      properties: {
        servicoId: {
          type: "string",
          description: "Id do serviço (ex.: limpeza).",
        },
        preferencia: {
          type: "string",
          description: "Preferência opcional (manhã, domingo, etc.).",
        },
      },
      required: ["servicoId"],
    },
  },
  {
    name: "confirmar_agendamento",
    description:
      "Confirma e cria o evento no Google SOMENTE com escolha inequívoca de um horário proposto e nome completo.",
    input_schema: {
      type: "object" as const,
      properties: {
        slotEscolhido: { type: "string" },
        nomeCompleto: { type: "string" },
      },
      required: ["slotEscolhido", "nomeCompleto"],
    },
  },
  {
    name: "registrar_falha_entendimento",
    description:
      "Registra que você não entendeu o cliente neste assunto. Na segunda falha seguida no mesmo assunto, transfere automaticamente para humano.",
    input_schema: {
      type: "object" as const,
      properties: {
        assunto: {
          type: "string",
          description: "Assunto que não foi entendido (ex.: horario, servico).",
        },
      },
      required: ["assunto"],
    },
  },
  {
    name: "acionar_handoff",
    description:
      "Transfere para humano e silencia o bot. Obrigatório para temas_sempre_humano (reclamacao, cobranca, processo…), urgência, preço sob avaliação, serviço inexistente ou erro. Informe o tema/motivo.",
    input_schema: {
      type: "object" as const,
      properties: {
        motivo: {
          type: "string",
          description:
            "Motivo ou tema (ex.: reclamacao, urgencia_clinica, preco_nao_informado).",
        },
        intencao: {
          type: "string",
          description: "O que o cliente queria, em uma frase.",
        },
      },
      required: ["motivo"],
    },
  },
];
