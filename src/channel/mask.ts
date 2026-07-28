/** Mascara wa_id / telefone para logs de aplicação. */
export function maskPhone(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (digits.length <= 4) {
    return "****";
  }
  const visible = digits.slice(-4);
  const prefix = digits.slice(0, Math.min(4, digits.length - 4));
  return `${prefix}****${visible}`;
}
