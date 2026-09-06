// Policy engine unit tests. Run with: npx vitest run tests/policy.spec.ts
import { describe, expect, it } from 'vitest'
import { explainPolicy, normalizePolicy, resolvePolicy, validatePolicy } from '../src/policy.ts'
import type { PolicyDocumentV1 } from '../src/types.ts'

const authorAll = { modelInvocable: true, userInvocable: true }

describe('validatePolicy', () => {
  it('accepts an empty version 1 document', () => {
    expect(validatePolicy({ version: 1 })).toEqual({ valid: true, value: { version: 1 }, issues: [] })
  })

  it('rejects unknown versions, unknown keys, and bad identifiers', () => {
    expect(validatePolicy({ version: 2 }).valid).toBe(false)
    expect(validatePolicy({ version: 1, extra: {} }).valid).toBe(false)
    expect(validatePolicy({ version: 1, presets: { '': { mode: 'all' } } }).valid).toBe(false)
    expect(validatePolicy({ version: 1, global: { skills: { 'Bad_Name': 'allow' } } }).valid).toBe(false)
    expect(validatePolicy({ version: 1, global: { mode: 'anything' } }).valid).toBe(false)
  })

  it('reports every issue with JSON Pointers', () => {
    const result = validatePolicy({ version: 1, global: { mode: 'bogus', skills: { x: 'nope' } } })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      const paths = result.issues.map(issue => issue.path)
      expect(paths).toContain('/global/mode')
      expect(paths).toContain('/global/skills/x')
    }
  })
})

describe('normalizePolicy', () => {
  it('fills missing layers and sorts keys deterministically', () => {
    const normalized = normalizePolicy({
      version: 1,
      global: { mode: 'deny-list' },
      presets: { z: { mode: 'all' }, a: { skills: { b: 'deny' } } },
    })
    expect(Object.keys(normalized.presets)).toEqual(['a', 'z'])
    expect(normalized.global.mode).toBe('deny-list')
    expect(normalized.global.skills).toEqual({})
    expect(normalized.sessions).toEqual({})
  })
})

describe('resolvePolicy and explainPolicy', () => {
  const request = (skill: string, invocation: 'model' | 'user', context = {}) => ({
    skill,
    invocation,
    author: authorAll,
    ...context,
  })

  it('defaults to allow when no policy exists', () => {
    expect(resolvePolicy({ version: 1 }, request('anything', 'model'))).toBe(true)
  })

  it('denies through the author gate regardless of layered policy', () => {
    const document: PolicyDocumentV1 = { version: 1, global: { skills: { x: 'allow' } } }
    expect(resolvePolicy(document, {
      skill: 'x', invocation: 'model', author: { modelInvocable: false, userInvocable: true },
    })).toBe(false)
  })

  it('lets the most specific non-inherit decision win', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { skills: { x: 'allow' } },
      presets: { p: { skills: { x: 'deny' } } },
    }
    expect(resolvePolicy(document, request('x', 'model', { preset: 'p' }))).toBe(false)
    expect(resolvePolicy(document, request('x', 'user', { preset: 'missing' }))).toBe(true)
  })

  it('distinguishes allow-list and deny-list defaults', () => {
    const allowList: PolicyDocumentV1 = { version: 1, global: { mode: 'allow-list' } }
    const denyList: PolicyDocumentV1 = { version: 1, global: { mode: 'deny-list' } }
    expect(resolvePolicy(allowList, request('x', 'model'))).toBe(false)
    expect(resolvePolicy(denyList, request('x', 'model'))).toBe(true)
    const allowed: PolicyDocumentV1 = { version: 1, global: { mode: 'allow-list', skills: { x: 'allow' } } }
    expect(resolvePolicy(allowed, request('x', 'model'))).toBe(true)
  })

  it('explains the decisive rule and ordered layers', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { mode: 'allow-list' },
      sessions: { s: { mode: 'deny-list', skills: { x: 'allow' } } },
    }
    const explanation = explainPolicy(document, request('x', 'model', { session: 's' }))
    expect(explanation.allowed).toBe(true)
    expect(explanation.reason).toBe('skill-allow')
    expect(explanation.steps.map(step => step.scope)).toEqual(['global', 'preset', 'workspace', 'session'])
    expect(explanation.steps[3]?.state).toBe('allow')
  })

  it('treats an absent document layer as inherit', () => {
    const document: PolicyDocumentV1 = { version: 1, global: { skills: { x: 'allow' } } }
    const explanation = explainPolicy(document, request('y', 'model'))
    expect(explanation.allowed).toBe(true)
    expect(explanation.reason).toBe('mode-all')
  })
})
