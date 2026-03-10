import { useEffect, useState } from 'react'
import { apiClient } from '../api/client'
import type { AuthorizationLevel, CapabilityClass, SettingsData } from '../types/ui'

export function useSettings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    try {
      setLoading(true)
      setError(null)
      setSettings(await apiClient.getSettings())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load settings')
    } finally {
      setLoading(false)
    }
  }

  async function updatePreference(
    capabilityClass: CapabilityClass,
    authorizationLevel: AuthorizationLevel,
  ) {
    await apiClient.updatePreference({
      capability_class: capabilityClass,
      authorization_level: authorizationLevel,
    })
    await load()
  }

  return { settings, loading, error, updatePreference }
}
