import type { SelectedCanonicalCompilationSource } from './compiled-synthesis-compiler-types'
import type { CompiledRecentChangeItem } from './compiled-synthesis-section-types'
import {
  maybeSection,
  normalizeLine,
  pushStructuredSignal,
} from './compiled-synthesis-signal-line-parsers'
import type { ParsedSelectionSignals } from './compiled-synthesis-signal-types'
export type * from './compiled-synthesis-signal-types'

function parseCanonicalDocumentSignals(document: SelectedCanonicalCompilationSource): ParsedSelectionSignals {
  const signals: ParsedSelectionSignals = {
    whyItMatters: [],
    currentState: [],
    facts: [],
    relationships: [],
    changes: [],
    decisions: [],
    questions: [],
    actions: [],
    contradictions: [],
  }
  let activeSection: SectionKind = null

  for (const rawLine of document.body.split(/\r?\n/)) {
    const line = normalizeLine(rawLine)
    if (!line) continue
    const heading = maybeSection(line)
    if (heading) {
      activeSection = heading
      continue
    }

    const directMatch = /^([^:]+):\s*(.+)$/.exec(line)
    if (directMatch) {
      const directSection = maybeSection(directMatch[1])
      if (directSection) {
        pushStructuredSignal(signals, directSection, directMatch[2].trim(), document.capturedAt)
        activeSection = directSection
        continue
      }
    }

    if (activeSection) {
      pushStructuredSignal(signals, activeSection, line, document.capturedAt)
      continue
    }

    if (!document.title || line.toLowerCase() !== document.title.trim().toLowerCase()) {
      signals.currentState.push(line)
    }
  }

  return signals
}

export function collectSelectionSignals(
  documents: SelectedCanonicalCompilationSource[],
): ParsedSelectionSignals {
  return documents.reduce<ParsedSelectionSignals>((aggregate, document) => {
    const parsed = parseCanonicalDocumentSignals(document)
    aggregate.whyItMatters.push(...parsed.whyItMatters)
    aggregate.currentState.push(...parsed.currentState)
    aggregate.facts.push(...parsed.facts)
    aggregate.relationships.push(...parsed.relationships)
    aggregate.changes.push(...parsed.changes)
    aggregate.decisions.push(...parsed.decisions)
    aggregate.questions.push(...parsed.questions)
    aggregate.actions.push(...parsed.actions)
    aggregate.contradictions.push(...parsed.contradictions)
    return aggregate
  }, {
    whyItMatters: [],
    currentState: [],
    facts: [],
    relationships: [],
    changes: [],
    decisions: [],
    questions: [],
    actions: [],
    contradictions: [],
  })
}

export function summarizeRecentChanges(changes: CompiledRecentChangeItem[]): string {
  if (changes.length === 0) return 'No explicit recent changes were extracted from the selected canonical sources.'
  if (changes.length === 1) return changes[0]!.summary
  return `${changes[0]!.summary} ${changes.length - 1} additional recent change(s) remain in view.`
}
