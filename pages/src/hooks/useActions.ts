import { useEffect, useState } from 'react'
import { apiClient } from '../api/client'
import { UNDO_WINDOW_MS, type ActionRow } from '../types/ui'

function withUndoExpiry(action: ActionRow): ActionRow {
  if (action.state !== 'completed_reversible' || action.executed_at == null) return action
  return { ...action, undo_expires_at: action.executed_at + UNDO_WINDOW_MS }
}

export function useActions() {
  const [actions, setActions] = useState<ActionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setLoading(true)
      setError(null)
      const response = await apiClient.getActions('awaiting_approval,completed_reversible')
      setActions(response.actions.map(withUndoExpiry))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load actions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()

    const workerUrl = import.meta.env.VITE_WORKER_URL?.replace(/\/$/, '')
    if (!workerUrl) return

    const socket = new WebSocket(`${workerUrl.replace(/^http/, 'ws')}/ws`)
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type?: string }
      if (payload.type?.startsWith('action.')) void refresh()
    }

    return () => socket.close()
  }, [])

  async function approve(actionId: string) {
    const previous = actions
    setActions(current => current.filter(action => action.id !== actionId))
    try {
      await apiClient.approveAction(actionId)
    } catch (err) {
      setActions(previous)
      setError(err instanceof Error ? err.message : 'Unable to approve action')
    }
  }

  async function reject(actionId: string, reason?: string) {
    const previous = actions
    setActions(current => current.filter(action => action.id !== actionId))
    try {
      await apiClient.rejectAction(actionId, reason)
    } catch (err) {
      setActions(previous)
      setError(err instanceof Error ? err.message : 'Unable to reject action')
    }
  }

  async function undo(actionId: string) {
    try {
      await apiClient.undoAction(actionId)
      setActions(current => current.filter(action => action.id !== actionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to undo action')
    }
  }

  return { actions, loading, error, approve, reject, undo, refresh }
}
