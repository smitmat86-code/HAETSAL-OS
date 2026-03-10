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
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const publicKeyBytes = new Uint8Array(
      publicKeyHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)),
    )
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    )
    const signedPayload = `${timestamp}|${body}`
    const signatureBytes = new Uint8Array(
      atob(signature).split('').map(c => c.charCodeAt(0)),
    )
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
