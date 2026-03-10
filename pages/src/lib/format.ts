export function formatRelativeTime(timestamp: number): string {
  const diffMs = timestamp - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)

  if (Math.abs(diffMinutes) < 1) return 'just now'
  if (Math.abs(diffMinutes) < 60) {
    return `${Math.abs(diffMinutes)} min ${diffMinutes < 0 ? 'ago' : 'from now'}`
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return `${Math.abs(diffHours)} hr ${diffHours < 0 ? 'ago' : 'from now'}`
  }

  return new Date(timestamp).toLocaleString()
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value)
}

export function formatClock(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60_000)
  const seconds = Math.floor((remainingMs % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
