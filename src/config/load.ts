import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { ClientConfigSchema, type ClientConfig } from "./schema.js";

const ENV_VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

export function expandEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_VAR_PATTERN, (_match, name: string) => {
      const envValue = env[name];
      if (envValue === undefined) {
        throw new ConfigLoadError(
          `Variável de ambiente não definida: ${name} (referenciada como \${${name}})`,
        );
      }
      return envValue;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item, env));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = expandEnvVars(nested, env);
    }
    return result;
  }

  return value;
}

export function formatZodError(error: ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(raiz)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");

  return `Configuração inválida:\n${details}`;
}

export function loadConfigFromYaml(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): ClientConfig {
  const absolutePath = resolve(filePath);

  let rawText: string;
  try {
    rawText = readFileSync(absolutePath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Não foi possível ler o arquivo de config: ${absolutePath}\n${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`YAML inválido em ${absolutePath}:\n${reason}`);
  }

  let expanded: unknown;
  try {
    expanded = expandEnvVars(parsed, env);
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(
      err instanceof Error ? err.message : `Falha ao expandir variáveis de ambiente: ${String(err)}`,
    );
  }

  const result = ClientConfigSchema.safeParse(expanded);
  if (!result.success) {
    throw new ConfigLoadError(formatZodError(result.error));
  }

  return result.data;
}
