import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config/index.js";
import { ConfigLoadError, expandEnvVars, loadConfigFromYaml } from "../src/config/load.js";

const FIXTURE_ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone-id",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

const VALID_YAML = `
cliente:
  id: clinica-exemplo
  nome: Clínica Exemplo
  timezone: America/Sao_Paulo

whatsapp:
  phone_number_id: "\${WHATSAPP_PHONE_NUMBER_ID}"
  access_token: "\${WHATSAPP_ACCESS_TOKEN}"
  verify_token: "\${WHATSAPP_VERIFY_TOKEN}"
  webhook_path: /webhook/whatsapp

google_calendar:
  calendar_id: "\${GOOGLE_CALENDAR_ID}"

funcionamento:
  dias: [segunda, terca, quarta, quinta, sexta]
  horario:
    inicio: "08:00"
    fim: "18:00"
  intervalo_almoco:
    inicio: "12:00"
    fim: "13:00"

agenda:
  buffer_entre_atendimentos_min: 10
  antecedencia_minima_horas: 2
  janela_maxima_dias: 14
  feriados: ["2026-01-01"]

profissionais:
  - id: dra-ana
    nome: Dra. Ana Silva
    servicos: [consulta, retorno]
    calendario_id: "\${GOOGLE_CALENDAR_ANA}"

servicos:
  - id: consulta
    nome: Consulta inicial
    duracao_min: 40
    preco: 280
  - id: retorno
    nome: Retorno
    duracao_min: 20
    preco: null

local:
  endereco: Rua das Flores, 123
  cidade: São Paulo
  estado: SP

pagamento:
  formas: [pix, cartao]
  instrucoes: PIX preferencial.

faq:
  - pergunta: Como remarcar?
    resposta: Com 24h de antecedência.

tom_de_voz:
  estilo: profissional e acolhedor
  linguagem: pt-BR
  evitar: [gírias]

handoff:
  gatilhos_explicitos: [falar com atendente]
  temas_sempre_humano: [reclamacao]
  gatilhos: [preco_nao_informado]
  numero_humano: "\${HANDOFF_WHATSAPP}"
  mensagem: Transferindo para a recepção.
  fora_do_horario: Fora do horário; a recepção retorna depois.
`;

function writeTempYaml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chatbot-config-"));
  const path = join(dir, "cliente.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

function withPatch(patch: (yaml: string) => string): string {
  return writeTempYaml(patch(VALID_YAML));
}

afterEach(() => {
  ConfigService.reset();
});

describe("loadConfigFromYaml", () => {
  it("carrega config válida", () => {
    const path = writeTempYaml(VALID_YAML);
    const config = loadConfigFromYaml(path, FIXTURE_ENV);

    expect(config.cliente.id).toBe("clinica-exemplo");
    expect(config.whatsapp.phone_number_id).toBe("phone-id");
    expect(config.servicos).toHaveLength(2);
    expect(config.servicos.find((s) => s.id === "retorno")?.preco).toBeNull();
  });

  it("expande variáveis ${ENV}", () => {
    const expanded = expandEnvVars(
      { token: "${WHATSAPP_ACCESS_TOKEN}", nested: { id: "${WHATSAPP_PHONE_NUMBER_ID}" } },
      FIXTURE_ENV,
    );
    expect(expanded).toEqual({ token: "token", nested: { id: "phone-id" } });
  });

  it("falha se variável de ambiente estiver ausente", () => {
    const path = writeTempYaml(VALID_YAML);
    expect(() => loadConfigFromYaml(path, {})).toThrow(ConfigLoadError);
    expect(() => loadConfigFromYaml(path, {})).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });

  it("rejeita duracao_min <= 0 com erro específico", () => {
    const path = withPatch((yaml) =>
      yaml.replace("duracao_min: 40", "duracao_min: 0"),
    );

    expect(() => loadConfigFromYaml(path, FIXTURE_ENV)).toThrow(ConfigLoadError);
    try {
      loadConfigFromYaml(path, FIXTURE_ENV);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).message).toMatch(/duracao_min/);
      expect((err as ConfigLoadError).message).toMatch(/maior que 0/);
    }
  });

  it("rejeita serviço inexistente referenciado em profissionais", () => {
    const path = withPatch((yaml) =>
      yaml.replace("servicos: [consulta, retorno]", "servicos: [consulta, limpeza]"),
    );

    try {
      loadConfigFromYaml(path, FIXTURE_ENV);
      expect.unreachable("deveria ter falhado");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      const message = (err as ConfigLoadError).message;
      expect(message).toMatch(/limpeza/);
      expect(message).toMatch(/profissionais\[0\]\.servicos/);
      expect(message).toMatch(/não existe em servicos/);
    }
  });

  it("rejeita horário com formato inválido", () => {
    const path = withPatch((yaml) => yaml.replace('inicio: "08:00"', 'inicio: "8:00"'));

    try {
      loadConfigFromYaml(path, FIXTURE_ENV);
      expect.unreachable("deveria ter falhado");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).message).toMatch(/HH:MM/);
    }
  });

  it("rejeita horário com inicio >= fim", () => {
    const path = withPatch((yaml) =>
      yaml
        .replace('inicio: "08:00"', 'inicio: "18:00"')
        .replace('fim: "18:00"', 'fim: "08:00"'),
    );

    try {
      loadConfigFromYaml(path, FIXTURE_ENV);
      expect.unreachable("deveria ter falhado");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).message).toMatch(/deve ser anterior a fim/);
    }
  });

  it("rejeita timezone IANA inválido", () => {
    const path = withPatch((yaml) =>
      yaml.replace("timezone: America/Sao_Paulo", "timezone: Marte/Olympus"),
    );

    try {
      loadConfigFromYaml(path, FIXTURE_ENV);
      expect.unreachable("deveria ter falhado");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).message).toMatch(/timezone inválido/);
      expect((err as ConfigLoadError).message).toMatch(/Marte\/Olympus/);
    }
  });

  it("aceita servico com preco null", () => {
    const path = writeTempYaml(VALID_YAML);
    const config = loadConfigFromYaml(path, FIXTURE_ENV);
    const retorno = config.servicos.find((s) => s.id === "retorno");
    expect(retorno).toBeDefined();
    expect(retorno?.preco).toBeNull();
  });

  it("agendavel default true quando omitido no YAML", () => {
    const path = writeTempYaml(VALID_YAML);
    const config = loadConfigFromYaml(path, FIXTURE_ENV);
    expect(config.servicos.every((s) => s.agendavel === true)).toBe(true);
  });

  it("aceita agendavel: false no serviço", () => {
    const path = withPatch((yaml) =>
      yaml.replace(
        "duracao_min: 40\n    preco: 280",
        "duracao_min: 40\n    preco: 280\n    agendavel: false",
      ),
    );
    const config = loadConfigFromYaml(path, FIXTURE_ENV);
    expect(config.servicos.find((s) => s.id === "consulta")?.agendavel).toBe(
      false,
    );
    expect(config.servicos.find((s) => s.id === "retorno")?.agendavel).toBe(
      true,
    );
  });

  it("ConfigService singleton expõe a config tipada", () => {
    const path = writeTempYaml(VALID_YAML);
    ConfigService.load(path, FIXTURE_ENV);
    expect(ConfigService.get().cliente.nome).toBe("Clínica Exemplo");
  });
});
