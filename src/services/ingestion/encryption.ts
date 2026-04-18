export async function encryptContentForArchive(
  content: string,
  tmk: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(content)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    tmk,
    data,
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}
