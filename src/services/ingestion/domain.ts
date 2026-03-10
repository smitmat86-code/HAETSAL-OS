// src/services/ingestion/domain.ts
// Domain inference from content keywords
// Default domain: 'general'

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  career: [
    'work', 'job', 'office', 'boss', 'manager', 'coworker', 'colleague',
    'project', 'deadline', 'promotion', 'salary', 'interview', 'resume',
    'meeting', 'standup', 'sprint', 'client', 'deliverable',
  ],
  health: [
    'doctor', 'hospital', 'medication', 'exercise', 'workout', 'gym',
    'diet', 'sleep', 'therapy', 'mental health', 'anxiety', 'stress',
    'symptom', 'diagnosis', 'appointment', 'prescription',
  ],
  finance: [
    'budget', 'savings', 'investment', 'stock', 'portfolio', 'tax',
    'insurance', 'mortgage', 'rent', 'expense', 'income', 'debt',
    'credit', 'bank', 'payment', 'invoice',
  ],
  relationships: [
    'family', 'friend', 'partner', 'spouse', 'parent', 'child', 'sibling',
    'date', 'relationship', 'wedding', 'birthday', 'anniversary',
    'conflict', 'trust', 'love',
  ],
  learning: [
    'learn', 'study', 'course', 'book', 'read', 'research', 'skill',
    'tutorial', 'class', 'lecture', 'certificate', 'degree',
  ],
}

/**
 * Infer domain from content using keyword matching
 * Returns the domain with the most keyword hits, or 'general'
 */
export function inferDomain(content: string): string {
  const lower = content.toLowerCase()
  let bestDomain = 'general'
  let bestScore = 0

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.filter(kw => lower.includes(kw)).length
    if (score > bestScore) {
      bestScore = score
      bestDomain = domain
    }
  }

  return bestDomain
}

/**
 * Infer memory type from content
 * Ingestion content defaults to 'episodic' — facts about what happened
 */
export function inferMemoryType(
  content: string,
  explicitType?: 'episodic' | 'semantic' | 'world',
): 'episodic' | 'semantic' | 'world' {
  if (explicitType) return explicitType
  return 'episodic'
}
