import type {
  GoogleSourceKind,
  GoogleSourceReadAttribution,
  GoogleSourceReadProfile,
  GoogleSourceRef,
} from '../types/google-source-read'

export const GOOGLE_SOURCE_READ_PROFILE: GoogleSourceReadProfile = {
  surface: 'brain-sources-read',
  canReadGmail: true,
  canReadCalendar: true,
  canReadDrive: true,
  canWriteGoogle: false,
  rejectsNaiveMirroring: true,
  keepsGoogleAuthoritative: true,
  feedsCanonicalBrain: true,
}

function trimOrNull(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value.trim().slice(0, 240))
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.trim() ? decoded : null
  } catch {
    return null
  }
}

export function googleSourceUrl(kind: GoogleSourceKind, sourceId: string): string {
  return kind === 'gmail'
    ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(sourceId)}`
    : kind === 'calendar'
      ? `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(sourceId)}`
      : `https://drive.google.com/file/d/${encodeURIComponent(sourceId)}/view`
}

export function buildGoogleSourceRef(ref: GoogleSourceRef): string {
  const sourceUrl = trimOrNull(ref.sourceUrl) ?? googleSourceUrl(ref.kind, ref.sourceId)
  return [
    ref.surface,
    ref.kind,
    encodeSegment(ref.sourceId),
    encodeSegment(sourceUrl),
    ref.explicitInclusion ? 'explicit' : 'selective',
  ].join(':')
}

export function parseGoogleSourceReadAttribution(args: {
  sourceSystem: string | null
  sourceRef: string | null
}): GoogleSourceReadAttribution | null {
  if (!args.sourceRef?.startsWith('brain-sources-read:')) return null
  const [surface, rawKind, rawId, rawUrl, rawMode] = args.sourceRef.split(':', 5)
  if (surface !== 'brain-sources-read' || !rawKind || !rawId || !rawUrl || !rawMode) return null
  if (rawKind !== 'gmail' && rawKind !== 'calendar' && rawKind !== 'drive') return null
  return {
    surface: 'brain-sources-read',
    kind: rawKind,
    sourceId: decodeSegment(rawId) ?? rawId,
    sourceUrl: decodeSegment(rawUrl),
    explicitInclusion: rawMode === 'explicit',
  }
}
