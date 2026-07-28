/** Máscara para relatório: só últimos 4 dígitos. */
export function maskPhoneReport(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `****${digits.slice(-4)}`;
}
