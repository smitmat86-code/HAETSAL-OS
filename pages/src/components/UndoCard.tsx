import { formatClock, formatRelativeTime } from '../lib/format'
import type { ActionRow } from '../types/ui'
import { useCountdown } from '../hooks/useCountdown'

interface UndoCardProps {
  action: ActionRow
  onUndo: (actionId: string) => Promise<void>
}

export function UndoCard({ action, onUndo }: UndoCardProps) {
  const { remaining, expired } = useCountdown(action.undo_expires_at ?? Date.now())

  return (
    <article className="card card-success">
      <div className="badge badge-green">Executed</div>
      <h3>{action.tool_name}</h3>
      <p className="meta-line">{action.integration} · {formatRelativeTime(action.executed_at ?? Date.now())}</p>
      <button
        className="success-button"
        disabled={expired}
        onClick={() => void onUndo(action.id)}
        type="button"
      >
        {expired ? 'Undo expired' : `Undo · ${formatClock(remaining)} remaining`}
      </button>
    </article>
  )
}
