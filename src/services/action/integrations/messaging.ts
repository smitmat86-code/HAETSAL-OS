// src/services/action/integrations/messaging.ts
// act_send_message executor. Routes an outbound message to a real channel:
//   imessage -> Sendblue, telegram -> Telegram Bot API, sms -> Telnyx.
// Gmail (email) send is NOT wired: Google OAuth is not provisioned this run
// (mission S5). Rather than a silent stub, the email path throws a clear
// "not connected" error so the action records a real, honest failure and the
// user learns Gmail needs setup (see docs/lessons/phase-5-google-oauth-*).

import type { Env } from '../../../types/env'
import { sendSmsReply } from '../../delivery/sms'
import { sendSendblueMessage } from '../../delivery/sendblue'
import { sendTelegramReply } from '../../delivery/telegram'

export type MessageChannel = 'sms' | 'imessage' | 'telegram' | 'email'

export interface MessagingResult {
  channel: MessageChannel
  delivered: boolean
  detail: string
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
  input: { recipient: string; message: string; channel?: string },
  env: Env,
): Promise<MessagingResult> {
  const channel = inferChannel(input.recipient, input.channel)

  if (channel === 'email') {
    // S5: do not work around. Fail honestly.
    throw new GmailNotConnectedError()
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
