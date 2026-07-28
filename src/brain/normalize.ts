/** Normaliza texto para matching de serviços/aliases (minúsculas, sem acentos). */
export function normalizeTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}
