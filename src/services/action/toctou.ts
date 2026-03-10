// src/services/action/toctou.ts
// TOCTOU protection: hash at proposal, verify at execution
// LESSON: crypto.subtle.timingSafeEqual — never hand-roll constant-time comparison

export async function hashPayload(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyPayloadHash(
  payload: string,
  storedHash: string
): Promise<boolean> {
  const freshHash = await hashPayload(payload)
  const a = new TextEncoder().encode(freshHash)
  const b = new TextEncoder().encode(storedHash)

  if (a.length !== b.length) return false

  // LESSON: crypto.subtle.timingSafeEqual — never string equality
  return crypto.subtle.timingSafeEqual(a, b)
}
