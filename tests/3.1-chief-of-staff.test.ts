// tests/3.1-chief-of-staff.test.ts
// Chief of Staff — class shape. The Phase-3.1 text-parsed delegation signal
// (parseDelegation/[DELEGATE:...]) was removed in mission Phase 6; delegation
// is native sub-agent dispatch now (see tests/mission-6.2-delegation.test.ts).

import { describe, it, expect } from 'vitest'
import { ChiefOfStaff } from '../src/agents/chief-of-staff'

describe('Chief of Staff — class shape', () => {
  it('no longer exposes the text-parsed delegation signal', () => {
    expect((ChiefOfStaff.prototype as unknown as Record<string, unknown>).parseDelegation).toBeUndefined()
  })

  it('readonly domain is an instance field, not a prototype property', () => {
    const descriptor = Object.getOwnPropertyDescriptor(ChiefOfStaff.prototype, 'domain')
    expect(descriptor).toBeUndefined()
  })
})
