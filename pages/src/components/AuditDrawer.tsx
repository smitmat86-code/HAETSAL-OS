import { formatRelativeTime } from '../lib/format'
import type { AuditRow } from '../types/ui'

interface AuditDrawerProps {
  actionId: string | null
  rows: AuditRow[]
  onClose: () => void
}

export function AuditDrawer({ actionId, rows, onClose }: AuditDrawerProps) {
  if (!actionId) return null

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Audit trail</p>
          <h3>{actionId}</h3>
        </div>
        <button className="ghost-button" onClick={onClose} type="button">Close</button>
      </div>
      <div className="timeline">
        {rows.map((row) => (
          <article className="timeline-item" key={row.id}>
            <p className="timeline-event">{row.event}</p>
            <p className="meta-line">{formatRelativeTime(row.created_at)}</p>
            {row.detail_json ? <pre>{row.detail_json}</pre> : null}
          </article>
        ))}
      </div>
    </aside>
  )
}
