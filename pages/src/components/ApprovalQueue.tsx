import type { ActionRow } from '../types/ui'
import { ActionCard } from './ActionCard'
import { UndoCard } from './UndoCard'

interface ApprovalQueueProps {
  actions: ActionRow[]
  loading: boolean
  error: string | null
  onApprove: (actionId: string) => Promise<void>
  onReject: (actionId: string, reason?: string) => Promise<void>
  onUndo: (actionId: string) => Promise<void>
}

export function ApprovalQueue({
  actions,
  loading,
  error,
  onApprove,
  onReject,
  onUndo,
}: ApprovalQueueProps) {
  const approvals = actions.filter(action => action.state === 'awaiting_approval')
  const reversible = actions.filter(action => action.state === 'completed_reversible')

  if (loading) return <section className="panel">Loading approval queue…</section>
  if (error) return <section className="panel error-panel">{error}</section>
  if (approvals.length === 0 && reversible.length === 0) {
    return (
      <section className="panel empty-panel">
        <h2>Nothing pending</h2>
        <p>THE Brain has no actions waiting on you right now.</p>
      </section>
    )
  }

  return (
    <section className="queue-grid">
      {approvals.map((action) => (
        <ActionCard key={action.id} action={action} onApprove={onApprove} onReject={onReject} />
      ))}
      {reversible.map((action) => (
        <UndoCard key={action.id} action={action} onUndo={onUndo} />
      ))}
    </section>
  )
}
