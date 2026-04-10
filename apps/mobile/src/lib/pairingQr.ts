const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("Scanned QR code did not contain a pairing URL.");
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Treat non-URL payloads as raw pairing-url text so the normal input validation can decide.
  }

  return trimmed;
}
