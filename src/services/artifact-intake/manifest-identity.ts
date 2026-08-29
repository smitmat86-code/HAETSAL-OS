import { sha256Text } from './crypto'

export interface ArtifactManifestIdentityItem {
  uploadId: string
  role: 'source' | 'derivative'
  parentUploadId: string | null
  primary: boolean
  mediaType: string
  byteLength: number
  plaintextSha256: string
}

export async function artifactManifestIdentitySha256(
  items: ArtifactManifestIdentityItem[],
): Promise<string> {
  return sha256Text(JSON.stringify(items.map(item => ({
    uploadId: item.uploadId,
    role: item.role,
    parentUploadId: item.parentUploadId,
    primary: item.primary,
    mediaType: item.mediaType.toLowerCase(),
    byteLength: Number(item.byteLength),
    plaintextSha256: item.plaintextSha256.toLowerCase(),
  }))))
}
