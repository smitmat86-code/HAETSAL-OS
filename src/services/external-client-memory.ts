import type {
  BrainMemoryRolloutAttribution,
  BrainMemorySurfaceProfile,
  ExternalClientCaptureInput,
  ExternalClientCaptureNormalization,
  ExternalClientCapturePattern,
  ExternalClientCaptureMode,
} from '../types/external-client-memory'

export const BRAIN_MEMORY_SURFACE_PROFILE: BrainMemorySurfaceProfile = {
  surface: 'brain-memory',
  canCapture: true,
  canQuery: true,
  canReadSources: false,
  canMutateSources: false,
  recommendedDefaultCaptureMode: 'session_summary',
  rejectsFullTranscriptDefault: true,
  writeToolNames: ['capture_memory'],
  readToolNames: [
    'search_memory',
    'trace_relationship',
    'get_entity_timeline',
    'prepare_context_for_agent',
    'get_recent_memories',
    'get_document',
    'memory_status',
    'memory_stats',
  ],
}

export const EXTERNAL_CLIENT_CAPTURE_PATTERNS: ExternalClientCapturePattern[] = [
  { id: 'explicit', label: 'explicit capture', durableValue: 'Intentional fact, decision, rule, or preference worth retaining.' },
  { id: 'session_summary', label: 'session-close summary', durableValue: 'Preferred default compounding path for what changed, decisions, open loops, and next steps.' },
  { id: 'artifact', label: 'artifact-linked capture', durableValue: 'Durable meaning plus provenance for a spec, plan, doc, or review artifact.' },
]

const SURFACE_PREFIX = 'brain-memory'

function trimOrNull(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value.trim().slice(0, 120))
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.trim() ? decoded : null
  } catch {
    return null
  }
}

function defaultProvenance(mode: ExternalClientCaptureMode): string {
  return mode === 'explicit' ? 'user_authored' : 'agent_authored'
}

function buildLocator(mode: ExternalClientCaptureMode, input: ExternalClientCaptureInput): string {
  const explicit = trimOrNull(input.source_ref)
  const session = trimOrNull(input.session_id)
  const artifact = trimOrNull(input.artifact_filename) ?? trimOrNull(input.title) ?? 'artifact'
  return mode === 'session_summary' ? (session ?? 'session-close')
    : mode === 'artifact' ? artifact
      : (explicit ?? 'capture')
}

export function usesBrainMemoryRollout(input: ExternalClientCaptureInput): boolean {
  return Boolean(
    input.capture_mode || input.client_name || input.session_id || input.title ||
    input.source_ref || input.artifact_ref || input.artifact_filename ||
    input.artifact_media_type || input.artifact_byte_length,
  )
}

export function normalizeExternalClientCapture(input: ExternalClientCaptureInput): ExternalClientCaptureNormalization {
  const captureMode = input.capture_mode ?? 'explicit'
  const clientName = trimOrNull(input.client_name) ?? 'mcp-native-client'
  const provenance = trimOrNull(input.provenance) ?? defaultProvenance(captureMode)
  const locator = buildLocator(captureMode, input)
  const artifactRef = captureMode === 'artifact' || trimOrNull(input.artifact_ref) || trimOrNull(input.artifact_filename)
    ? {
      mode: 'stored_r2' as const,
      storageKey: trimOrNull(input.artifact_ref),
      filename: trimOrNull(input.artifact_filename) ?? trimOrNull(input.title),
      mediaType: trimOrNull(input.artifact_media_type),
      byteLength: input.artifact_byte_length ?? null,
    }
    : null

  return {
    captureMode,
    clientName,
    provenance,
    sourceSystem: 'mcp:memory_write',
    sourceRef: [SURFACE_PREFIX, captureMode, encodeSegment(provenance), encodeSegment(clientName), encodeSegment(locator)].join(':'),
    title: trimOrNull(input.title) ?? (captureMode === 'session_summary' ? 'Session summary' : artifactRef?.filename ?? null),
    artifactRef,
    metadata: {
      title: trimOrNull(input.title) ?? undefined,
      brain_memory: {
        surface: BRAIN_MEMORY_SURFACE_PROFILE.surface,
        capture_mode: captureMode,
        provenance,
        client_name: clientName,
        session_id: trimOrNull(input.session_id),
        artifact_ref: trimOrNull(input.artifact_ref),
        rejects_full_transcript_default: true,
      },
    },
  }
}

export function parseBrainMemoryRolloutAttribution(args: {
  sourceSystem: string | null
  sourceRef: string | null
  artifactRef?: string | null
}): BrainMemoryRolloutAttribution | null {
  if (args.sourceSystem !== 'mcp:memory_write' || !args.sourceRef?.startsWith(`${SURFACE_PREFIX}:`)) return null
  const [surface, rawMode, rawProvenance, rawClient, rawLocator] = args.sourceRef.split(':', 5)
  if (surface !== SURFACE_PREFIX || !rawMode || !rawProvenance || !rawClient || !rawLocator) return null
  if (rawMode !== 'explicit' && rawMode !== 'session_summary' && rawMode !== 'artifact') return null
  const captureMode = rawMode as ExternalClientCaptureMode
  const locator = decodeSegment(rawLocator)
  return {
    surface: 'brain-memory',
    captureMode,
    provenance: decodeSegment(rawProvenance) ?? rawProvenance,
    clientName: decodeSegment(rawClient),
    locator,
    sessionId: captureMode === 'session_summary' ? locator : null,
    artifactRef: captureMode === 'artifact' ? (args.artifactRef ?? locator) : null,
  }
}
