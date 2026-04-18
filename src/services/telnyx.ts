// src/services/telnyx.ts
// Telnyx webhook Ed25519 signature verification
// Uses Web Crypto API (native in workerd) — no npm package needed

/**
 * Verify Telnyx Ed25519 webhook signature
 */
export async function verifyTelnyxSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    const publicKeyBytes = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0))
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    )
    const signedPayload = `${timestamp}|${body}`
    const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0))
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signatureBytes,
      new TextEncoder().encode(signedPayload),
    )
  } catch {
    return false
  }
}
