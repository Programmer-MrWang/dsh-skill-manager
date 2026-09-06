// Wire contract tests: detached DTO parsing and descriptor invariants.
// Run with: npx vitest run tests/wire.spec.ts
import { describe, expect, it } from 'vitest'
import {
  METHODS,
  codec,
  invocation,
  param,
  parseDraft,
  parsePolicyDocument,
  parseSnapshot,
  parseSnapshotRequest,
  SERVICE,
  unwrap,
} from '../src/wire.ts'

describe('parseDraft', () => {
  it('parses a valid draft and rejects unknown fields', () => {
    const draft = parseDraft({
      name: 'alpha',
      description: 'Works.',
      body: '# Body',
      invocation: { modelInvocable: false },
      frontmatter: { license: 'MIT' },
    })
    expect(draft.name).toBe('alpha')
    expect(draft.invocation?.modelInvocable).toBe(false)
    expect(draft.invocation?.userInvocable).toBeUndefined()
    expect(draft.frontmatter?.license).toBe('MIT')
    expect(() => parseDraft({ name: 'x', description: '', body: '', sneaky: 1 })).toThrow(/not an allowed field/)
  })

  it('rejects malformed nested values', () => {
    expect(() => parseDraft({ name: 'x', description: 'd', body: '', invocation: 'yes' })).toThrow(/must be an object/)
    expect(() => parseDraft({ name: 'x', description: 'd', body: 3 })).toThrow(/must be a string/)
  })
})

describe('parsePolicyDocument', () => {
  it('parses and prunes inherit-only layers', () => {
    const doc = parsePolicyDocument({
      version: 1,
      global: { mode: 'allow-list', skills: { alpha: 'allow', beta: 'inherit' } },
      sessions: { s1: { mode: 'deny-list' } },
    })
    expect(doc.global?.mode).toBe('allow-list')
    expect(Object.keys(doc.global?.skills ?? {})).toEqual(['alpha'])
  })

  it('rejects non-version-1 documents', () => {
    expect(() => parsePolicyDocument({ version: 2 })).toThrow(/version must be 1/)
    expect(() => parsePolicyDocument(null)).toThrow(/must be an object/)
  })
})

describe('parseSnapshotRequest', () => {
  it('accepts an empty object and paired scope/id', () => {
    expect(parseSnapshotRequest({})).toEqual({})
    expect(parseSnapshotRequest({ scope: 'session', id: 's-1' })).toEqual({ scope: 'session', id: 's-1' })
  })

  it('rejects a lone id', () => {
    expect(() => parseSnapshotRequest({ id: 's-1' })).toThrow(/scope and id together/)
  })
})

describe('parseSnapshot', () => {
  it('parses a full detached snapshot and preserves explanations', () => {
    const snapshot = parseSnapshot({
      roots: [{ id: 'r1', kind: 'user-dsh', label: 'User', writable: true, available: true }],
      candidates: [{
        id: 'c1',
        name: 'alpha',
        description: 'Works.',
        source: 'user-dsh',
        provider: 'filesystem',
        rootId: 'r1',
        layout: 'bundle',
        editable: true,
        deletable: true,
        invocation: { modelInvocable: true, userInvocable: true },
        version: 'v1',
        diagnostics: [],
      }],
      effective: [{
        name: 'alpha',
        description: 'Works.',
        source: 'user-dsh',
        provider: 'filesystem',
        author: { modelInvocable: true, userInvocable: true },
        effective: true,
        model: {
          allowed: true,
          reason: 'mode-all',
          authorAllowed: true,
          mode: 'all',
          steps: [{ scope: 'global', present: false, mode: 'inherit', state: 'inherit', effectiveMode: 'all' }],
        },
        user: {
          allowed: false,
          reason: 'skill-deny',
          authorAllowed: true,
          mode: 'all',
          state: 'deny',
          steps: [{ scope: 'global', present: true, mode: 'all', state: 'deny', effectiveMode: 'all', effectiveState: 'deny' }],
        },
        effectiveInvocation: { modelInvocable: true, userInvocable: false },
      }],
      trash: [],
      scopeOptions: [],
      document: null,
      context: { session: 's-1' },
      revision: 3,
    })
    expect(snapshot.candidates[0]?.invocation.modelInvocable).toBe(true)
    expect(snapshot.effective[0]?.effectiveInvocation?.userInvocable).toBe(false)
    expect(snapshot.effective[0]?.user.reason).toBe('skill-deny')
    expect(snapshot.revision).toBe(3)
  })
})

describe('descriptor factory', () => {
  it('produces stable ids and the service namespace', () => {
    const id = (method: (typeof METHODS)[number]): string => `dsh-skill-manager#${SERVICE}/${method}`
    const text = codec('String', value => {
      if (typeof value !== 'string') throw new Error('not a string')
      return value
    })
    for (const method of METHODS) {
      const descriptor = invocation(method, [param('x', text)], text)
      expect(descriptor.id).toBe(id(method))
      expect(descriptor.namespace).toBe(SERVICE)
      expect(descriptor.invocation.kind).toBe('direct')
    }
  })
})

describe('unwrap', () => {
  it('returns values and maps failures to coded Errors', () => {
    expect(unwrap({ ok: true, value: 42 })).toBe(42)
    let failure: { code?: string; message: string } | undefined
    try {
      unwrap({ ok: false, error: { code: 'x', message: 'boom', details: { code: 'CONFLICT' } } })
    } catch (candidate) {
      failure = candidate as { code?: string; message: string }
    }
    expect(failure?.message).toBe('boom')
    expect(failure?.code).toBe('CONFLICT')
  })
})
