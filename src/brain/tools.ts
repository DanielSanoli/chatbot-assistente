import type { ClientConfig, Servico } from "../config/schema.js";
import type { CalendarClient } from "../calendar/google.js";
import type { Store } from "../store/index.js";
import { DateTime } from "luxon";
import { normalizeTerm } from "./normalize.js";
import {
  confirmarAgendamento,
  markHandoffState,
  proporHorarios,
  type BookingContext,
} from "./booking.js";

export const PRECO_SOB_AVALIACAO = "preco_sob_avaliacao" as const;

export type ToolName =
  | "buscar_servico"
  | "listar_servicos"
  | "info_local"
  | "info_pagamento"
  | "buscar_faq"
  | "acionar_handoff"
  | "propor_horarios"
  | "confirmar_agendamento";

export type ToolContext = {
  config: ClientConfig;
  store: Store;
  calendar: CalendarClient;
  waId: string;
  agora?: DateTime;
  userText?: string;
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
    };
  }

  return {
    encontrado: true,
    id: servico.id,
    nome: servico.nome,
    duracao_min: servico.duracao_min,
    preco: servico.preco,
    preco_status: "informado",
  };
}

export function listarServicos(config: ClientConfig) {
  return {
    servicos: config.servicos.map((s) => ({
      id: s.id,
      nome: s.nome,
      aliases: s.aliases,
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

export function acionarHandoff(config: ClientConfig, motivo: string) {
  return {
    handoff: true as const,
    motivo,
    mensagem: config.handoff.mensagem,
    contato: config.handoff.contato,
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
      markHandoffState(toBookingContext(ctx), motivo);
      return acionarHandoff(ctx.config, motivo);
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
      "Propõe 2–3 horários livres para um serviço (lê a agenda). Use quando o cliente quiser agendar. Nunca invente horários.",
    input_schema: {
      type: "object" as const,
      properties: {
        servicoId: {
          type: "string",
          description: "Id do serviço (ex.: limpeza). Prefira o id retornado por buscar_servico.",
        },
        preferencia: {
          type: "string",
          description: "Preferência opcional do cliente (manhã, tarde, dia da semana).",
        },
      },
      required: ["servicoId"],
    },
  },
  {
    name: "confirmar_agendamento",
    description:
      "Confirma e cria o evento no Google SOMENTE com escolha inequívoca de um horário proposto e nome completo. Nunca use se o cliente disser 'pode ser', 'qualquer um' ou 'tanto faz'.",
    input_schema: {
      type: "object" as const,
      properties: {
        slotEscolhido: {
          type: "string",
          description:
            "Identificador inequívoco: número da opção (1/2/3) ou dia/hora específicos do slot proposto.",
        },
        nomeCompleto: {
          type: "string",
          description: "Nome e sobrenome do paciente. Obrigatório.",
        },
      },
      required: ["slotEscolhido", "nomeCompleto"],
    },
  },
  {
    name: "acionar_handoff",
    description:
      "Transfere para a recepção humana e encerra a automação. Obrigatório quando faltar fonte, preço sob avaliação, serviço inexistente, ou a regra central exigir.",
    input_schema: {
      type: "object" as const,
      properties: {
        motivo: {
          type: "string",
          description:
            "Motivo do handoff (ex.: preco_nao_informado, servico_inexistente)",
        },
      },
      required: ["motivo"],
    },
  },
];
