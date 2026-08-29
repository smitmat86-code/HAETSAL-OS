import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, ARTIFACT_MAX_BYTES, ARTIFACT_MAX_REDIRECTS } from './config'

export interface HostedArtifactFileDescriptor {
  download_url: string
  file_id: string
  mime_type?: string
  file_name?: string
}

export interface ArtifactDownloadResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  remoteAddress: string | null
  cancel: () => void
}

export interface ArtifactDownloadNetwork {
  connectionSafety?: 'peer_address' | 'isolated_fetch'
  resolve: (hostname: string) => Promise<string[]>
  request: (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<ArtifactDownloadResponse>
}

export interface DownloadedArtifactFile {
  bytes: Uint8Array
  detectedMimeType: string
  declaredMimeType?: string
  redirectCount: number
}

export interface ArtifactDownloadLimits {
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
}

export const DEFAULT_ARTIFACT_DOWNLOAD_LIMITS: ArtifactDownloadLimits = Object.freeze({
  maxBytes: ARTIFACT_MAX_BYTES,
  timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  maxRedirects: ARTIFACT_MAX_REDIRECTS,
})
