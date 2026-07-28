import { loadConfigFromYaml } from "./load.js";
import type { ClientConfig } from "./schema.js";

/**
 * Singleton tipado da configuração do cliente.
 * Nenhum outro módulo deve ler o YAML diretamente — use ConfigService.get().
 */
export class ConfigService {
  private static instance: ClientConfig | null = null;
  private static sourcePath: string | null = null;

  static load(configPath: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
    const config = loadConfigFromYaml(configPath, env);
    ConfigService.instance = config;
    ConfigService.sourcePath = configPath;
    return config;
  }

  static get(): ClientConfig {
    if (!ConfigService.instance) {
      throw new Error(
        "ConfigService ainda não foi inicializado. Chame ConfigService.load(path) na subida do servidor.",
      );
    }
    return ConfigService.instance;
  }

  static getSourcePath(): string | null {
    return ConfigService.sourcePath;
  }

  /** Apenas para testes — limpa o singleton entre casos. */
  static reset(): void {
    ConfigService.instance = null;
    ConfigService.sourcePath = null;
  }
}
