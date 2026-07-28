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
  duracao_min: z
    .number({
      required_error: "duracao_min é obrigatório",
      invalid_type_error: "duracao_min deve ser um número",
    })
    .int("duracao_min deve ser um inteiro")
    .positive("duracao_min deve ser maior que 0"),
  /** null = não informar preço; transferir no handoff */
  preco: z.number().nonnegative().nullable(),
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
  credentials_path: z.string().min(1),
});

export const FuncionamentoSchema = z.object({
  dias: z.array(z.string().min(1)).min(1),
  horario: HorarioSchema,
  intervalo_almoco: HorarioSchema.optional(),
});

export const LocalSchema = z.object({
  endereco: z.string().min(1),
  bairro: z.string().min(1).optional(),
  cidade: z.string().min(1),
  estado: z.string().min(1),
  cep: z.string().min(1).optional(),
  complemento: z.string().min(1).optional(),
  referencia: z.string().min(1).optional(),
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
  gatilhos: z.array(z.string().min(1)).min(1),
  contato: z.string().min(1),
  mensagem: z.string().min(1),
});

export const ClientConfigSchema = z
  .object({
    cliente: ClienteSchema,
    whatsapp: WhatsappSchema,
    google_calendar: GoogleCalendarSchema,
    funcionamento: FuncionamentoSchema,
    profissionais: z.array(ProfissionalSchema).min(1),
    servicos: z.array(ServicoSchema).min(1),
    local: LocalSchema,
    pagamento: PagamentoSchema,
    faq: z.array(FaqItemSchema).default([]),
    tom_de_voz: TomDeVozSchema,
    handoff: HandoffSchema,
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
