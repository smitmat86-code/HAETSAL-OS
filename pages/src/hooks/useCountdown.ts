import { useEffect, useState } from 'react'

export function useCountdown(expiresAt: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))

  useEffect(() => {
    if (remaining <= 0) return

    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [expiresAt, remaining])

  return {
    remaining,
    expired: remaining <= 0,
  }
}
