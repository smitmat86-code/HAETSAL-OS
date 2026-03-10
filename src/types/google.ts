// src/types/google.ts
// Google API types — OAuth tokens, Gmail threads, Calendar events, Drive files

export interface GoogleOAuthTokens {
  access_token: string
  refresh_token: string
  expires_at: number        // unix ms
  scope: string
}

export interface GoogleThread {
  id: string
  historyId: string
  messages: GoogleMessage[]
}

export interface GoogleMessage {
  id: string
  threadId: string
  internalDate: string      // unix ms as string
  payload: {
    headers: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: Array<{ mimeType: string; body?: { data?: string } }>
  }
}

export interface GoogleCalendarEvent {
  id: string
  summary: string
  description?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string; displayName?: string }>
  htmlLink: string
}

export interface GoogleDriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  parents?: string[]
}

export interface GoogleWebhookChannel {
  channelId: string
  channelToken: string       // pre-shared secret verified on each webhook
  resourceType: 'gmail' | 'calendar'
  tenantId: string
  expiresAt: number          // unix ms
}
