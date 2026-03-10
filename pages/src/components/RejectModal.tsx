import { useState } from 'react'

interface RejectModalProps {
  onCancel: () => void
  onConfirm: (reason?: string) => Promise<void>
}

export function RejectModal({ onCancel, onConfirm }: RejectModalProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(includeReason: boolean) {
    setBusy(true)
    try {
      await onConfirm(includeReason ? reason.trim() || undefined : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="reject-modal">
      <label className="field-label" htmlFor="reject-reason">Optional reason</label>
      <textarea
        id="reject-reason"
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Explain why this action should not proceed."
      />
      <div className="modal-actions">
        <button className="ghost-button" onClick={onCancel} type="button">Cancel</button>
        <button className="ghost-button" disabled={busy} onClick={() => void submit(false)} type="button">
          Reject without reason
        </button>
        <button className="danger-button" disabled={busy} onClick={() => void submit(true)} type="button">
          Reject
        </button>
      </div>
    </div>
  )
}
