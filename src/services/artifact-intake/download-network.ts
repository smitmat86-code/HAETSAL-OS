import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { normalizeArtifactIpAddress } from './download-policy'
import type { ArtifactDownloadNetwork, ArtifactDownloadResponse } from './download-types'

function headersFrom(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, String(value))
    }
  }
  return headers
}

function webBody(response: IncomingMessage, cancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on('data', (chunk: Uint8Array) => controller.enqueue(Uint8Array.from(chunk)))
      response.once('end', () => controller.close())
      response.once('error', error => controller.error(error))
      response.once('aborted', () => controller.error(new Error('download_aborted')))
    },
    cancel,
  })
}

async function resolveDefault(hostname: string): Promise<string[]> {
  const literal = normalizeArtifactIpAddress(hostname)
  if (literal) return [literal]
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map(result => result.address)
  } catch {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  }
}

async function requestPinnedHttps(
  url: URL,
  pinnedAddress: string,
  signal: AbortSignal,
): Promise<ArtifactDownloadResponse> {
  const family = pinnedAddress.includes(':') ? 6 : 4
  return new Promise((resolve, reject) => {
    let settled = false
    const request = httpsRequest({
      protocol: 'https:', hostname: url.hostname, port: 443, method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close', Host: url.hostname,
      },
      maxHeaderSize: 16 * 1024,
      agent: false,
      signal,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) => {
        if (options.all) callback(null, [{ address: pinnedAddress, family }])
        else callback(null, pinnedAddress, family)
      }) as never,
    }, response => {
      const cancel = () => { response.destroy(); request.destroy() }
      const remoteAddress = normalizeArtifactIpAddress(response.socket.remoteAddress ?? '')
      if (!remoteAddress || remoteAddress !== normalizeArtifactIpAddress(pinnedAddress)) {
        cancel()
        reject(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED))
        return
      }
      settled = true
      resolve({
        status: response.statusCode ?? 0,
        headers: headersFrom(response),
        body: webBody(response, cancel),
        remoteAddress,
        cancel,
      })
    })
    request.once('error', error => { if (!settled) reject(error) })
    request.end()
  })
}

export const DEFAULT_ARTIFACT_DOWNLOAD_NETWORK: ArtifactDownloadNetwork = Object.freeze({
  resolve: resolveDefault,
  request: requestPinnedHttps,
})
