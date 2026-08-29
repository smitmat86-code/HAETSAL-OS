function begins(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function decodedText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

/** Content sniffing is authoritative; transport and descriptor MIME values are only declarations. */
export function detectArtifactMimeType(bytes: Uint8Array): string {
  if (begins(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (begins(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (begins(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    begins(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  if (begins(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  if (begins(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'

  const text = decodedText(bytes)
  if (text === null) return 'application/octet-stream'
  const trimmed = text.trimStart()
  if (/^<!doctype\s+html\b/i.test(trimmed) || /^<html\b/i.test(trimmed)) return 'text/html'
  if (/^<\?xml\b/i.test(trimmed)) return 'application/xml'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'application/json'
    } catch {
      // Valid UTF-8 that merely resembles JSON remains plain text.
    }
  }
  return 'text/plain'
}
