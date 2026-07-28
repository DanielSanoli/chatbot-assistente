/**
 * Canal WhatsApp — stub V0.
 * Integração real (webhook, envio) entra em features posteriores.
 */
export function createWhatsappChannel() {
  return {
    name: "whatsapp" as const,
    ready: false,
  };
}
