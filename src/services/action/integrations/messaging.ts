// src/services/action/integrations/messaging.ts
// act_send_message executor. Routes an outbound message to a real channel:
//   imessage -> Sendblue, telegram -> Telegram Bot API, sms -> Telnyx.
// Email sends use the tenant's encrypted Google grant. Missing OAuth fails
// honestly before any external mutation.

import type { Env } from '../../../types/env'
import { sendSmsReply } from '../../delivery/sms'
import { sendSendblueMessage } from '../../delivery/sendblue'
import { sendTelegramReply } from '../../delivery/telegram'
import { getGoogleToken } from '../../google/oauth'
import { sendGmailMessage } from '../../google/gmail'

export type MessageChannel = 'sms' | 'imessage' | 'telegram' | 'email'

export interface MessagingResult {
  channel: MessageChannel
  delivered: boolean
  detail: string
}

export interface GoogleMessageAuth {
  tenantId: string
  tmk: CryptoKey
}

/** The one legitimate S5 boundary in this executor: Gmail needs Google OAuth. */
export class GmailNotConnectedError extends Error {
  constructor() {
    super('Gmail send requires Google OAuth, which is not connected. '
      + 'See docs/lessons/phase-5-google-oauth-setup.md to enable it.')
    this.name = 'GmailNotConnectedError'
  }
}

function inferChannel(recipient: string, channel?: string): MessageChannel {
  if (channel === 'email' || (!channel && recipient.includes('@'))) return 'email'
  if (channel === 'imessage' || channel === 'telegram' || channel === 'sms') return channel
  return 'sms'
}

export async function executeSendMessage(
  input: { recipient: string; message: string; channel?: string; subject?: string; thread_id?: string },
  env: Env,
  googleAuth?: GoogleMessageAuth,
): Promise<MessagingResult> {
  const channel = inferChannel(input.recipient, input.channel)

  if (channel === 'email') {
    if (!googleAuth) throw new GmailNotConnectedError()
    const token = await getGoogleToken(googleAuth.tenantId, 'gmail.send', googleAuth.tmk, env)
    if (!token) throw new GmailNotConnectedError()
    const sent = await sendGmailMessage({
      recipient: input.recipient,
      subject: input.subject,
      message: input.message,
      threadId: input.thread_id,
    }, token)
    return { channel, delivered: true, detail: `gmail:${sent.messageId}` }
  }

  if (channel === 'imessage') {
    const sent = await sendSendblueMessage(input.recipient, input.message, env)
    if (!sent.success) throw new Error(`iMessage send failed: status ${sent.status}`)
    return { channel, delivered: true, detail: 'sendblue' }
  }

  if (channel === 'telegram') {
    const ok = await sendTelegramReply(input.recipient, input.message, env)
    if (!ok) throw new Error('Telegram send failed')
    return { channel, delivered: true, detail: 'telegram' }
  }

  // sms via Telnyx
  const ok = await sendSmsReply(input.recipient, input.message, env)
  if (!ok) throw new Error('SMS send failed')
  return { channel, delivered: true, detail: 'telnyx' }
}
