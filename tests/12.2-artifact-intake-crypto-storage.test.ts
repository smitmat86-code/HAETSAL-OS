import { describe, expect, it } from 'vitest'
import { ArtifactIntakeContractError } from '../src/services/artifact-intake/contracts'
import {
  detectArtifactEnvelopeFamily,
  sealArtifactBytes,
  sha256Bytes,
  unsealArtifactBytes,
} from '../src/services/artifact-intake/crypto'
import { managedArtifactR2Key } from '../src/services/artifact-intake/storage'

async function key(label: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(label.padEnd(32, '!').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

describe('12.2 artifact intake binary crypto and deterministic storage keys', () => {
  it('seals arbitrary binary bytes as family-tagged ciphertext and round-trips both key families', async () => {
    const plaintext = new Uint8Array([0, 255, 1, 2, 3, 10, 13, ...new TextEncoder().encode('recognizable-fixture')])
    for (const family of ['tmk', 'kek'] as const) {
      const cryptoKey = await key(`artifact-${family}`)
      const sealed = await sealArtifactBytes(plaintext, cryptoKey, family)
      expect(detectArtifactEnvelopeFamily(sealed.envelope)).toBe(family)
      expect(new TextDecoder().decode(sealed.envelope)).not.toContain('recognizable-fixture')
      expect(sealed.plaintextSha256).toBe(await sha256Bytes(plaintext))
      expect(sealed.ciphertextSha256).toBe(await sha256Bytes(sealed.envelope))
      expect(await unsealArtifactBytes(sealed.envelope, cryptoKey, family)).toEqual(plaintext)
    }
  })

  it('fails loudly for cross-family use, wrong keys, and tampering', async () => {
    const plaintext = new TextEncoder().encode('family-bound-payload')
    const tmk = await key('tmk-correct')
    const sealed = await sealArtifactBytes(plaintext, tmk, 'tmk')
    await expect(unsealArtifactBytes(sealed.envelope, tmk, 'kek')).rejects.toMatchObject({
      code: 'encryption_family_mismatch',
    } satisfies Partial<ArtifactIntakeContractError>)
    await expect(unsealArtifactBytes(sealed.envelope, await key('tmk-wrong'), 'tmk')).rejects.toMatchObject({
      code: 'ciphertext_invalid',
    } satisfies Partial<ArtifactIntakeContractError>)
    const tampered = sealed.envelope.slice()
    tampered[tampered.length - 1] ^= 1
    await expect(unsealArtifactBytes(tampered, tmk, 'tmk')).rejects.toMatchObject({ code: 'ciphertext_invalid' })
  })

  it('formats stable tenant-scoped keys without embedding the tenant identifier', async () => {
    const uploadId = crypto.randomUUID()
    const first = await managedArtifactR2Key('tenant-private-name', uploadId)
    const retry = await managedArtifactR2Key('tenant-private-name', uploadId)
    const otherTenant = await managedArtifactR2Key('tenant-other', uploadId)
    expect(first).toBe(retry)
    expect(first).not.toBe(otherTenant)
    expect(first).not.toContain('tenant-private-name')
    expect(first).toMatch(/^artifact-intake\/v1\/[a-f0-9]{32}\/[a-f0-9-]{36}\.enc$/)
  })
})
