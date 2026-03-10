// tests/3.1-router.test.ts
// Layer 1 Router — pattern matching and classifier fallback

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { routeRequest } from '../src/services/agents/router'

describe('Layer 1 Router — pattern matching', () => {
  it('routes career keywords to career_coach', async () => {
    expect(await routeRequest('Help me prep for my job interview', env)).toBe('career_coach')
    expect(await routeRequest('I need to update my project timeline', env)).toBe('career_coach')
    expect(await routeRequest('Should I ask for a promotion?', env)).toBe('career_coach')
  })

  it('routes health keywords to life_coach', async () => {
    expect(await routeRequest('I need a better workout routine', env)).toBe('life_coach')
    expect(await routeRequest('How much sleep should I be getting?', env)).toBe('life_coach')
    expect(await routeRequest('Schedule a doctor appointment', env)).toBe('life_coach')
  })

  it('routes finance keywords to career_coach', async () => {
    expect(await routeRequest('Track my monthly budget', env)).toBe('career_coach')
    expect(await routeRequest('I got an invoice from the contractor', env)).toBe('career_coach')
  })

  it('routes planning keywords to chief_of_staff', async () => {
    expect(await routeRequest('Remind me to call mom', env)).toBe('chief_of_staff')
    expect(await routeRequest('Schedule a meeting for Friday', env)).toBe('chief_of_staff')
    expect(await routeRequest('Help me plan my week', env)).toBe('chief_of_staff')
  })

  it('routes relationship keywords to chief_of_staff', async () => {
    expect(await routeRequest('My friend needs advice', env)).toBe('chief_of_staff')
    expect(await routeRequest('Family dinner this weekend', env)).toBe('chief_of_staff')
  })
})

describe('Layer 1 Router — fallback', () => {
  it('defaults to chief_of_staff for ambiguous input', async () => {
    // This will attempt the classifier call which will fail in test (stubbed AI)
    // and fall back to chief_of_staff
    const result = await routeRequest('What should I think about today?', env)
    expect(result).toBe('chief_of_staff')
  })
})
