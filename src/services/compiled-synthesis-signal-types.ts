export interface ParsedFactSignal {
  kind: string
  label: string
  summary: string
}

export interface ParsedRelationshipSignal {
  relationshipType: string
  counterpartName: string | null
  summary: string
}

export interface ParsedChangeSignal {
  changeKind: string
  summary: string
  changedAt: number
}

export interface ParsedDecisionSignal {
  decisionKey: string
  summary: string
}

export interface ParsedQuestionSignal {
  question: string
  owner: string | null
}

export interface ParsedActionSignal {
  owner: string | null
  summary: string
}

export interface ParsedContradictionSignal {
  contradictionKind: string
  summary: string
}

export interface ParsedSelectionSignals {
  whyItMatters: string[]
  currentState: string[]
  facts: ParsedFactSignal[]
  relationships: ParsedRelationshipSignal[]
  changes: ParsedChangeSignal[]
  decisions: ParsedDecisionSignal[]
  questions: ParsedQuestionSignal[]
  actions: ParsedActionSignal[]
  contradictions: ParsedContradictionSignal[]
}
