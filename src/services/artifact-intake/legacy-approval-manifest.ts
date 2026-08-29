import type { LegacyPrivateInventoryEntry } from './legacy-inventory'

export interface ExactTargetManifestEntry {
  objectIdentityHmac: string
  ownershipHmac: string
  byteCount: number
  objectVersion: string | null
  objectSha256: string
  objectEtag: string
  channel: 'telegram' | 'sendblue'
  disposition: 'migrate_replace_delete' | 'delete_confirmed_orphan'
  reconciliationState: string
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  if (secret.length < 16) throw new Error('invalid_approval_hmac_secret')
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildExactTargetManifest(
  entries: LegacyPrivateInventoryEntry[], approvalHmacSecret: string,
): Promise<ExactTargetManifestEntry[]> {
  const targets = entries.filter(entry =>
    entry.disposition === 'migrate_replace_delete' || entry.disposition === 'delete_confirmed_orphan')
  const exact = await Promise.all(targets.map(async entry => {
    if (!entry.r2Present || !entry.etag || !entry.objectSha256 || !/^[a-f0-9]{64}$/i.test(entry.objectSha256)) {
      throw new Error('unsafe_exact_target')
    }
    if (entry.disposition === 'migrate_replace_delete' && (!entry.tenantId || !entry.captureId)) {
      throw new Error('unsafe_exact_target')
    }
    return {
      objectIdentityHmac: await hmacSha256(approvalHmacSecret, `object\0${entry.key}`),
      ownershipHmac: await hmacSha256(
        approvalHmacSecret, `ownership\0${entry.tenantId ?? 'orphan'}\0${entry.captureId ?? 'orphan'}`,
      ),
      byteCount: entry.size,
      objectVersion: entry.version,
      objectSha256: entry.objectSha256,
      objectEtag: entry.etag,
      channel: entry.channel,
      disposition: entry.disposition,
      reconciliationState: entry.reconciliationState,
    } satisfies ExactTargetManifestEntry
  }))
  return exact.sort((left, right) => left.objectIdentityHmac.localeCompare(right.objectIdentityHmac))
}
