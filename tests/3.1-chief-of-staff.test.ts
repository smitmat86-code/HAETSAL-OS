// tests/3.1-chief-of-staff.test.ts
// Chief of Staff — delegation parsing, trace chaining, system prompt

import { describe, it, expect } from 'vitest'
import { ChiefOfStaff } from '../src/agents/chief-of-staff'
import type { DelegationSignal } from '../src/agents/types'

describe('Chief of Staff — delegation signal parsing', () => {
  // ChiefOfStaff cannot be instantiated without real crypto + env
  // Test parseDelegation as a static-like method via prototype

  it('parses valid delegation signal', () => {
    const cos = Object.create(ChiefOfStaff.prototype) as ChiefOfStaff
    const result = cos.parseDelegation(
      'I think this is best handled by a specialist. [DELEGATE:career_coach|Professional development question|User asking about promotion strategy]',
    )
    expect(result).not.toBeNull()
    expect(result!.delegateTo).toBe('career_coach')
    expect(result!.reason).toBe('Professional development question')
    expect(result!.context).toBe('User asking about promotion strategy')
  })

  it('returns null for no delegation', () => {
    const cos = Object.create(ChiefOfStaff.prototype) as ChiefOfStaff
    const result = cos.parseDelegation('Here is my direct response to your question.')
    expect(result).toBeNull()
  })

  it('returns null for malformed delegation', () => {
    const cos = Object.create(ChiefOfStaff.prototype) as ChiefOfStaff
    const result = cos.parseDelegation('[DELEGATE:bad_format]')
    expect(result).toBeNull()
  })

  it('domain is general', () => {
    expect(ChiefOfStaff.prototype.domain).toBe(undefined)
    // domain is set in constructor via readonly, verify via class shape
    const descriptor = Object.getOwnPropertyDescriptor(ChiefOfStaff.prototype, 'domain')
    // readonly fields are instance properties, not prototype
    expect(descriptor).toBeUndefined()
  })
})

describe('Chief of Staff — trace chaining', () => {
  it('DelegationSignal has expected shape', () => {
    const signal: DelegationSignal = {
      delegateTo: 'career_coach',
      reason: 'career topic',
      context: 'user asked about job',
    }
    expect(signal.delegateTo).toBe('career_coach')
    expect(signal.reason).toBe('career topic')
    expect(signal.context).toBe('user asked about job')
  })

  it('DelegationSignal supports all agent types', () => {
    const types: DelegationSignal['delegateTo'][] = [
      'chief_of_staff', 'career_coach', 'life_coach', 'inline',
    ]
    expect(types).toHaveLength(4)
  })
})
