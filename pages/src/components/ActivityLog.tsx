import { useEffect, useState } from 'react'
import { apiClient } from '../api/client'
import { formatRelativeTime } from '../lib/format'
import type { AuditRow } from '../types/ui'
import { AuditDrawer } from './AuditDrawer'

export function ActivityLog() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null)
  const [drawerRows, setDrawerRows] = useState<AuditRow[]>([])
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    void loadPage(offset)
  }, [offset])

  async function loadPage(nextOffset: number) {
    const response = await apiClient.getAudit({ offset: nextOffset })
    setRows(response.rows)
    setTotal(response.total)
  }

  async function openDrawer(actionId: string) {
    setSelectedActionId(actionId)
    const response = await apiClient.getAudit({ actionId })
    setDrawerRows(response.rows)
  }

  return (
    <section className="panel table-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Activity log</p>
          <h2>Recent action history</h2>
        </div>
        <div className="pagination">
          <button className="ghost-button" disabled={offset === 0} onClick={() => setOffset(offset - 20)} type="button">
            Newer
          </button>
          <button className="ghost-button" disabled={offset + 20 >= total} onClick={() => setOffset(offset + 20)} type="button">
            Older
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Integration</th>
            <th>State</th>
            <th>Event</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => void openDrawer(row.action_id)}>
              <td>{formatRelativeTime(row.created_at)}</td>
              <td>{row.tool_name}</td>
              <td>{row.integration}</td>
              <td><span className={`state-pill state-${row.state}`}>{row.state}</span></td>
              <td>{row.event}</td>
              <td>{row.result_summary ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AuditDrawer actionId={selectedActionId} rows={drawerRows} onClose={() => setSelectedActionId(null)} />
    </section>
  )
}
