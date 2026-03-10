import { useState } from 'react'
import { formatMoney } from '../lib/format'
import { useSettings } from '../hooks/useSettings'
import type { AuthorizationLevel, PreferenceSetting } from '../types/ui'

const LEVELS: AuthorizationLevel[] = ['GREEN', 'YELLOW', 'RED']
const FEATURE_GOOGLE = import.meta.env.VITE_FEATURE_GOOGLE === 'true'
const FEATURE_BOOTSTRAP = import.meta.env.VITE_FEATURE_BOOTSTRAP === 'true'

function editable(pref: PreferenceSetting) {
  return pref.hard_floor === 'YELLOW'
}

export function Settings() {
  const { settings, loading, error, updatePreference } = useSettings()
  const [saving, setSaving] = useState<string | null>(null)

  if (loading) return <section className="panel">Loading settings…</section>
  if (error || !settings) return <section className="panel error-panel">{error ?? 'Unable to load settings'}</section>

  async function savePreference(pref: PreferenceSetting, nextLevel: AuthorizationLevel) {
    setSaving(pref.capability_class)
    try {
      await updatePreference(pref.capability_class, nextLevel)
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="settings-layout">
      <article className="panel">
        <p className="eyebrow">Authorization</p>
        <h2>Capability preferences</h2>
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Current</th>
              <th>Hard floor</th>
              <th>Update</th>
            </tr>
          </thead>
          <tbody>
            {settings.preferences.map((pref) => (
              <tr key={pref.capability_class}>
                <td>{pref.capability_class}</td>
                <td>{pref.effective_level}{pref.hmac_valid ? '' : ' · invalid HMAC'}</td>
                <td>{pref.hard_floor}</td>
                <td>
                  {editable(pref) ? (
                    <div className="inline-controls">
                      {LEVELS.filter(level => level !== 'GREEN').map(level => (
                        <button
                          key={level}
                          className={level === pref.authorization_level ? 'primary-button' : 'ghost-button'}
                          disabled={saving === pref.capability_class}
                          onClick={() => void savePreference(pref, level)}
                          type="button"
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article className="panel">
        <p className="eyebrow">AI cost</p>
        <h2>Spend tracking</h2>
        <div className="meter-group">
          <label>Daily</label>
          <div className="meter">
            <span style={{ width: `${Math.min(100, (settings.tenant.ai_cost_daily_usd / settings.tenant.ai_ceiling_daily_usd) * 100)}%` }} />
          </div>
          <p>{formatMoney(settings.tenant.ai_cost_daily_usd)} / {formatMoney(settings.tenant.ai_ceiling_daily_usd)}</p>
        </div>
        <div className="meter-group">
          <label>Monthly</label>
          <div className="meter">
            <span style={{ width: `${Math.min(100, (settings.tenant.ai_cost_monthly_usd / settings.tenant.ai_ceiling_monthly_usd) * 100)}%` }} />
          </div>
          <p>{formatMoney(settings.tenant.ai_cost_monthly_usd)} / {formatMoney(settings.tenant.ai_ceiling_monthly_usd)}</p>
        </div>
        <p className="meta-line">Reset at {new Date(settings.tenant.ai_cost_reset_at).toLocaleString()}</p>
      </article>

      <article className="panel">
        <p className="eyebrow">Contact</p>
        <h2>Tenant info</h2>
        <p>Primary channel: {settings.tenant.primary_channel}</p>
        <p>Primary phone: {settings.tenant.primary_phone ?? 'Not set'}</p>
        <p>Primary email: {settings.tenant.primary_email ?? 'Not set'}</p>
      </article>

      {FEATURE_GOOGLE ? <article className="panel"><h2>Google</h2><p>Stub reserved for Phase 2.2.</p></article> : null}
      {FEATURE_BOOTSTRAP ? <article className="panel"><h2>Bootstrap</h2><p>Stub reserved for Phase 2.4.</p></article> : null}
    </section>
  )
}
