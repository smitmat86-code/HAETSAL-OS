import { useState } from 'react'
import { formatRelativeTime } from '../lib/format'
import type { ActionRow } from '../types/ui'
import { RejectModal } from './RejectModal'

interface ActionCardProps {
  action: ActionRow
  onApprove: (actionId: string) => Promise<void>
  onReject: (actionId: string, reason?: string) => Promise<void>
}

export function ActionCard({ action, onApprove, onReject }: ActionCardProps) {
  const [showReject, setShowReject] = useState(false)
  const [busy, setBusy] = useState(false)

  async function approve() {
    setBusy(true)
    try {
      await onApprove(action.id)
    } finally {
      setBusy(false)
    }
  }

  async function reject(reason?: string) {
    setBusy(true)
    try {
      await onReject(action.id, reason)
    } finally {
      setBusy(false)
      setShowReject(false)
    }
  }

  return (
    <article className="card">
      <div className={`badge badge-${action.authorization_level.toLowerCase()}`}>
        {action.capability_class}
      </div>
      <h3>{action.tool_name}</h3>
      <p className="meta-line">{action.integration} · Proposed by {action.proposed_by}</p>
      <p className="meta-line">{formatRelativeTime(action.proposed_at)}</p>
      <div className="card-actions">
        <button className="primary-button" disabled={busy} onClick={() => void approve()} type="button">
          Approve
        </button>
        <button className="ghost-button" disabled={busy} onClick={() => setShowReject(!showReject)} type="button">
          Reject
        </button>
      </div>
      {showReject ? <RejectModal onCancel={() => setShowReject(false)} onConfirm={reject} /> : null}
    </article>
  )
}
