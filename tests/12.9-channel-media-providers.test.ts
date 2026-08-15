import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireChannelMedia, retrieveSendblueMediaUrl } from '../src/services/channel-media/providers'
import { ARTIFACT_INTAKE_ERROR } from '../src/services/artifact-intake/contracts'
import type { ChannelMediaDescriptor } from '../src/types/channel-media'
import type { Env } from '../src/types/env'

const telegram: ChannelMediaDescriptor = {
  version: 1,
  provider: 'telegram',
  locatorKind: 'telegram_file_id',
  locator: 'private-telegram-file-id',
  replyTarget: 'private-chat-id',
  caption: null,
  occurredAt: Date.now(),
}

const sendblue: ChannelMediaDescriptor = {
  version: 1,
  provider: 'sendblue',
  locatorKind: 'sendblue_message_handle',
  locator: 'private-sendblue-handle',
  replyTarget: '+15550001111',
  caption: null,
  occurredAt: Date.now(),
}

const testEnv = {
  TELEGRAM_BOT_TOKEN: 'private-bot-token',
  SENDBLUE_API_KEY_ID: 'private-sendblue-key-id',
  SENDBLUE_API_SECRET_KEY: 'private-sendblue-secret',
} as Env

afterEach(() => vi.unstubAllGlobals())

describe('12.9 channel provider acquisition boundaries', () => {
  it('uses the Telegram file identifier only against fixed Bot API origins and sniffs MIME from bytes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      calls.push({ url, init })
      if (url.includes('/getFile?')) {
        return new Response(JSON.stringify({
          ok: true, result: { file_path: 'photos/provider.jpg', file_size: 10 },
        }), { status: 200 })
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
      })
    }))
    const result = await acquireChannelMedia(telegram, testEnv)
    expect(result.detectedMimeType).toBe('image/jpeg')
    expect(calls).toHaveLength(2)
    expect(calls.every(call => new URL(call.url).hostname === 'api.telegram.org')).toBe(true)
    expect(calls.every(call => call.init?.redirect === 'manual')).toBe(true)
  })

  it('rejects Telegram path traversal, declared MIME mismatch, and streaming overflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, result: { file_path: '../secret', file_size: 10 },
    }), { status: 200 })))
    await expect(acquireChannelMedia(telegram, testEnv)).rejects.toMatchObject({
      code: ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID,
    })

    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), {
        headers: { 'content-type': 'image/png' },
      })
    }))
    await expect(acquireChannelMedia(telegram, testEnv)).rejects.toMatchObject({
      code: ARTIFACT_INTAKE_ERROR.MIME_MISMATCH,
    })

    call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }))
      return new Response('small', { headers: { 'content-length': String(20 * 1024 * 1024 + 1) } })
    }))
    await expect(acquireChannelMedia(telegram, testEnv)).rejects.toMatchObject({
      code: ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED,
    })
  })

  it('refetches Sendblue attachment metadata by stable message handle with authenticated routing', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init })
      return new Response(JSON.stringify({ data: {
        message_handle: sendblue.locator,
        from_number: sendblue.replyTarget,
        media_url: 'https://cdn.sendblue.example/temporary.jpg',
      } }), { status: 200 })
    }))
    expect(await retrieveSendblueMediaUrl(sendblue, testEnv))
      .toBe('https://cdn.sendblue.example/temporary.jpg')
    expect(calls[0]!.url).toBe(`https://api.sendblue.co/api/v2/messages/${sendblue.locator}`)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['sb-api-key-id']).toBe(testEnv.SENDBLUE_API_KEY_ID)
    expect(headers['sb-api-secret-key']).toBe(testEnv.SENDBLUE_API_SECRET_KEY)
    expect(calls[0]!.init?.redirect).toBe('manual')
  })

  it('rejects Sendblue cross-message and cross-sender substitution without exposing identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {
      message_handle: 'different-handle',
      from_number: sendblue.replyTarget,
      media_url: 'https://cdn.sendblue.example/temporary.jpg',
    } }))))
    await expect(retrieveSendblueMediaUrl(sendblue, testEnv)).rejects.toMatchObject({
      code: ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH,
      message: ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH,
    })
  })

  it('uses an encrypted-handoff temporary URL directly only when no stable handle exists', async () => {
    const fallback: ChannelMediaDescriptor = {
      ...sendblue,
      locatorKind: 'sendblue_temporary_url',
      locator: 'https://cdn.sendblue.example/temporary.jpg',
    }
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await retrieveSendblueMediaUrl(fallback, testEnv)).toBe(fallback.locator)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
