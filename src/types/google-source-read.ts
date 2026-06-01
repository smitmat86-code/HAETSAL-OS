export type GoogleSourceKind = 'gmail' | 'calendar' | 'drive'

export interface GoogleSourceRef {
  surface: 'brain-sources-read'
  kind: GoogleSourceKind
  sourceId: string
  sourceUrl?: string | null
  explicitInclusion?: boolean
}

export interface GoogleSourceReadAttribution {
  surface: 'brain-sources-read'
  kind: GoogleSourceKind
  sourceId: string
  sourceUrl: string | null
  explicitInclusion: boolean
}

export interface GoogleSourceReadProfile {
  surface: 'brain-sources-read'
  canReadGmail: true
  canReadCalendar: true
  canReadDrive: true
  canWriteGoogle: false
  rejectsNaiveMirroring: true
  keepsGoogleAuthoritative: true
  feedsCanonicalBrain: true
}
