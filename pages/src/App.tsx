import { useState } from 'react'
import { ActivityLog } from './components/ActivityLog'
import { ApprovalQueue } from './components/ApprovalQueue'
import { Settings } from './components/Settings'
import { useActions } from './hooks/useActions'

type Tab = 'queue' | 'activity' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('queue')
  const actions = useActions()

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Phase 1.4 console</p>
          <h1>THE Brain</h1>
          <p className="hero-copy">Approve external writes, watch reversible actions, and tune how aggressive the system is allowed to be.</p>
        </div>
        <nav className="tabs">
          <button className={tab === 'queue' ? 'tab active' : 'tab'} onClick={() => setTab('queue')} type="button">Queue</button>
          <button className={tab === 'activity' ? 'tab active' : 'tab'} onClick={() => setTab('activity')} type="button">Activity</button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')} type="button">Settings</button>
        </nav>
      </header>

      {tab === 'queue' ? (
        <ApprovalQueue
          actions={actions.actions}
          loading={actions.loading}
          error={actions.error}
          onApprove={actions.approve}
          onReject={actions.reject}
          onUndo={actions.undo}
        />
      ) : null}
      {tab === 'activity' ? <ActivityLog /> : null}
      {tab === 'settings' ? <Settings /> : null}
    </main>
  )
}
