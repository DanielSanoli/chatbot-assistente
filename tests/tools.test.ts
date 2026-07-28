import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config/index.js";
import {
  buscarServico,
  infoLocal,
  PRECO_SOB_AVALIACAO,
} from "../src/brain/tools.js";

const ENV: NodeJS.ProcessEnv = {
  WHATSAPP_PHONE_NUMBER_ID: "phone",
  WHATSAPP_ACCESS_TOKEN: "token",
  WHATSAPP_VERIFY_TOKEN: "verify",
  GOOGLE_CALENDAR_ID: "primary",
  GOOGLE_CREDENTIALS_PATH: "./creds.json",
  GOOGLE_CALENDAR_ANA: "ana@example.com",
  GOOGLE_CALENDAR_BRUNO: "bruno@example.com",
  HANDOFF_WHATSAPP: "+5511999999999",
};

afterEach(() => {
  ConfigService.reset();
});

describe("brain tools", () => {
  it("buscar_servico resolve alias tártaro → limpeza com preço do YAML", () => {
    const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
    const limpeza = config.servicos.find((s) => s.id === "limpeza");
    expect(limpeza?.preco).toBe(180);

    const byAlias = buscarServico(config, "tártaro");
    expect(byAlias.encontrado).toBe(true);
    if (!byAlias.encontrado) return;
    expect(byAlias.id).toBe("limpeza");
    expect(byAlias.preco).toBe(180);
    expect(byAlias.preco_status).toBe("informado");
  });

  it("buscar_servico com preco null devolve marcador preco_sob_avaliacao", () => {
    const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
    const result = buscarServico(config, "canal");
    expect(result.encontrado).toBe(true);
    if (!result.encontrado) return;
    expect(result.preco).toBeNull();
    expect(result.preco_status).toBe(PRECO_SOB_AVALIACAO);
    expect(result.marcador).toBe(PRECO_SOB_AVALIACAO);
  });

  it("buscar_servico serviço inexistente não inventa", () => {
    const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
    const result = buscarServico(config, "implante");
    expect(result.encontrado).toBe(false);
  });

  it("info_local inclui estacionamento", () => {
    const config = ConfigService.load("./clients/clinica-exemplo.yaml", ENV);
    const local = infoLocal(config);
    expect(local.estacionamento).toMatch(/estacionamento/i);
    expect(local.endereco).toBe(config.local.endereco);
  });
});
