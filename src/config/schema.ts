import { z } from "zod";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export const HorarioSchema = z
  .object({
    inicio: z
      .string()
      .regex(HH_MM, 'horário deve estar no formato HH:MM (ex.: "08:00")'),
    fim: z
      .string()
      .regex(HH_MM, 'horário deve estar no formato HH:MM (ex.: "18:00")'),
  })
  .superRefine((horario, ctx) => {
    if (parseMinutes(horario.inicio) >= parseMinutes(horario.fim)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inicio (${horario.inicio}) deve ser anterior a fim (${horario.fim})`,
        path: ["inicio"],
      });
    }
  });

export const ServicoSchema = z.object({
  id: z.string().min(1),
  nome: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  duracao_min: z
    .number({
      required_error: "duracao_min é obrigatório",
      invalid_type_error: "duracao_min deve ser um número",
    })
    .int("duracao_min deve ser um inteiro")
    .positive("duracao_min deve ser maior que 0"),
  /** null = não informar preço; transferir no handoff */
  preco: z.number().nonnegative().nullable(),
  /** false = informar/orientar, mas não marcar pelo assistente */
  agendavel: z.boolean().default(true),
});

export const ProfissionalSchema = z.object({
  id: z.string().min(1),
  nome: z.string().min(1),
  servicos: z.array(z.string().min(1)).min(1),
  calendario_id: z.string().min(1),
});

export const ClienteSchema = z.object({
  id: z.string().min(1),
  nome: z.string().min(1),
  timezone: z
    .string()
    .min(1)
    .refine(isValidIanaTimezone, (tz) => ({
      message: `timezone inválido (IANA): "${tz}"`,
    })),
});

export const WhatsappSchema = z.object({
  phone_number_id: z.string().min(1),
  access_token: z.string().min(1),
  verify_token: z.string().min(1),
  webhook_path: z.string().min(1),
});

export const GoogleCalendarSchema = z.object({
  calendar_id: z.string().min(1),
});

export const FuncionamentoSchema = z.object({
  dias: z.array(z.string().min(1)).min(1),
  horario: HorarioSchema,
  /** Ex.: sábado com expediente mais curto — sobrescreve horario padrão. */
  por_dia: z.record(HorarioSchema).default({}),
  intervalo_almoco: HorarioSchema.optional(),
});

export const AgendaSchema = z.object({
  buffer_entre_atendimentos_min: z.number().int().nonnegative(),
  antecedencia_minima_horas: z.number().nonnegative(),
  janela_maxima_dias: z.number().int().positive(),
  /** Grade de início dos slots (minutos). */
  passo_grade_min: z.number().int().positive().default(15),
  /**
   * Antecedência mínima para o assistente cancelar/remarcar sozinho. Abaixo
   * dela a decisão é da recepção (política de multa, encaixe, no-show), então
   * o pedido vira handoff em vez de virar buraco na agenda.
   */
  cancelamento_antecedencia_horas: z.number().nonnegative().default(4),
  /** Datas ISO YYYY-MM-DD no timezone do cliente. */
  feriados: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "feriado deve ser YYYY-MM-DD"))
    .default([]),
});

export const LocalSchema = z.object({
  endereco: z.string().min(1),
  bairro: z.string().min(1).optional(),
  cidade: z.string().min(1),
  estado: z.string().min(1),
  cep: z.string().min(1).optional(),
  complemento: z.string().min(1).optional(),
  referencia: z.string().min(1).optional(),
  estacionamento: z.string().min(1).optional(),
});

export const PagamentoSchema = z.object({
  formas: z.array(z.string().min(1)).min(1),
  instrucoes: z.string().min(1),
});

export const FaqItemSchema = z.object({
  pergunta: z.string().min(1),
  resposta: z.string().min(1),
});

export const TomDeVozSchema = z.object({
  estilo: z.string().min(1),
  linguagem: z.string().min(1),
  evitar: z.array(z.string().min(1)).default([]),
});

export const HandoffSchema = z.object({
  /** Frases do cliente que pedem humano (ex.: "falar com atendente"). */
  gatilhos_explicitos: z.array(z.string().min(1)).min(1),
  /** Temas que o modelo deve transferir sempre (reclamação, cobrança…). */
  temas_sempre_humano: z.array(z.string().min(1)).min(1),
  /** Motivos internos legados / ferramentas (preco_nao_informado, etc.). */
  gatilhos: z.array(z.string().min(1)).default([]),
  numero_humano: z.string().min(1),
  mensagem: z.string().min(1),
  fora_do_horario: z.string().min(1),
  silencio_em_humano_horas: z.number().positive().default(12),
});

export const PrivacidadeSchema = z.object({
  aviso_primeira_mensagem: z.string().min(1),
  retencao_dias: z.number().int().positive().default(180),
});

export const ClientConfigSchema = z
  .object({
    cliente: ClienteSchema,
    whatsapp: WhatsappSchema,
    google_calendar: GoogleCalendarSchema,
    funcionamento: FuncionamentoSchema,
    agenda: AgendaSchema,
    profissionais: z.array(ProfissionalSchema).min(1),
    servicos: z.array(ServicoSchema).min(1),
    local: LocalSchema,
    pagamento: PagamentoSchema,
    faq: z.array(FaqItemSchema).default([]),
    tom_de_voz: TomDeVozSchema,
    handoff: HandoffSchema,
    privacidade: PrivacidadeSchema,
  })
  .superRefine((config, ctx) => {
    const servicoIds = new Set(config.servicos.map((s) => s.id));

    config.profissionais.forEach((profissional, pIndex) => {
      profissional.servicos.forEach((servicoId, sIndex) => {
        if (!servicoIds.has(servicoId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `servico "${servicoId}" referenciado em profissionais[${pIndex}].servicos não existe em servicos`,
            path: ["profissionais", pIndex, "servicos", sIndex],
          });
        }
      });
    });
  });

export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type Servico = z.infer<typeof ServicoSchema>;
export type Profissional = z.infer<typeof ProfissionalSchema>;
