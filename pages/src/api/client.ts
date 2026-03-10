import type { ActionRow, AuditRow, AuthorizationLevel, CapabilityClass, SettingsData } from '../types/ui'

interface ActionResponse {
  actions: ActionRow[]
  total: number
  limit: number
  offset: number
}

interface AuditResponse {
  rows: AuditRow[]
  total: number
  limit: number
  offset: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

export const apiClient = {
  getActions(state: string): Promise<ActionResponse> {
    return request(`/api/actions?state=${encodeURIComponent(state)}`)
  },
  approveAction(actionId: string): Promise<{ action_id: string; state: string }> {
    return request(`/api/actions/${actionId}/approve`, { method: 'POST' })
  },
  rejectAction(actionId: string, reason?: string): Promise<{ action_id: string; state: string }> {
    return request(`/api/actions/${actionId}/reject`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    })
  },
  undoAction(actionId: string): Promise<{ action_id: string; status: string }> {
    return request(`/api/actions/${actionId}/undo`, { method: 'POST' })
  },
  getAudit(params?: { actionId?: string; offset?: number }): Promise<AuditResponse> {
    const search = new URLSearchParams()
    if (params?.actionId) search.set('action_id', params.actionId)
    if (params?.offset) search.set('offset', String(params.offset))
    return request(`/api/audit${search.size ? `?${search.toString()}` : ''}`)
  },
  getSettings(): Promise<SettingsData> {
    return request('/api/settings')
  },
  updatePreference(input: {
    capability_class: CapabilityClass
    authorization_level: AuthorizationLevel
  }): Promise<unknown> {
    return request('/api/settings/preferences', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
}
