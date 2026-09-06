// Runtime overlay engine unit tests: restriction computation and provider views.
// Run with: npx vitest run tests/runtime.spec.ts
import { describe, expect, it } from 'vitest'
import { computeOverlayRestrictions, OverlaySkillProvider, OVERLAY_PROVIDER } from '../src/runtime.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { PolicyDocumentV1 } from '../src/types.ts'

const skill = (name: string, modelInvocable = true, userInvocable = true): SkillSummary => ({
  name,
  description: `${name} does things.`,
  invocation: { modelInvocable, userInvocable },
  source: 'user-dsh',
  provider: 'filesystem',
})

const emptyContext = {}

describe('computeOverlayRestrictions', () => {
  it('returns no restrictions when there is no policy', () => {
    expect(computeOverlayRestrictions(null, emptyContext, [skill('a'), skill('b')])).toEqual([])
  })

  it('does not touch a skill the policy leaves allowed', () => {
    const document: PolicyDocumentV1 = { version: 1, global: { mode: 'deny-list' } }
    expect(computeOverlayRestrictions(document, emptyContext, [skill('a')])).toEqual([])
  })

  it('denies through the layered policy only when it tightens the author flags', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { mode: 'deny-list', skills: { 'denied-skill': 'deny' } },
    }
    const restrictions = computeOverlayRestrictions(document, emptyContext, [
      skill('denied-skill'),
      skill('allowed-skill'),
    ])
    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]?.summary.name).toBe('denied-skill')
    expect(restrictions[0]?.model).toBe(false)
    expect(restrictions[0]?.user).toBe(false)
  })

  it('applies allow-list defaults as denials unless overridden', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { mode: 'allow-list', skills: { 'listed-skill': 'allow' } },
    }
    const restrictions = computeOverlayRestrictions(document, emptyContext, [
      skill('listed-skill'),
      skill('other-skill'),
    ])
    expect(restrictions.map(entry => entry.summary.name)).toEqual(['other-skill'])
  })

  it('never re-enables an audience the author disabled', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { mode: 'allow-list', skills: { restricted: 'allow' } },
    }
    // Author allows model only; policy allow-list could not re-enable user.
    const authorRestricted = { ...skill('restricted'), invocation: { modelInvocable: true, userInvocable: false } }
    expect(computeOverlayRestrictions(document, emptyContext, [authorRestricted])).toEqual([])
  })

  it('resolves the most specific non-inherit layer for one skill', () => {
    const document: PolicyDocumentV1 = {
      version: 1,
      global: { mode: 'allow-list' },
      sessions: { s1: { mode: 'deny-list', skills: { 'session-skill': 'allow' } } },
    }
    // Session s1 replaces the global mode entirely: other skills are allowed.
    const inSession = computeOverlayRestrictions(document, { session: 's1' }, [skill('other-skill')])
    expect(inSession).toEqual([])
    // Outside s1 the global allow-list still denies unlisted skills.
    const outside = computeOverlayRestrictions(document, {}, [skill('other-skill')])
    expect(outside).toHaveLength(1)
  })
})

describe('OverlaySkillProvider', () => {
  const entry = (name: string, model: boolean, user: boolean, content = `body of ${name}`) => ({
    summary: skill(name),
    model,
    user,
    content,
    path: `/x/${name}`,
  })

  it('lists restricted candidates under the reserved provider name with rank 1', async () => {
    const provider = new OverlaySkillProvider([entry('alpha', false, true)])
    const candidates = (await provider.list()) as Array<Record<string, unknown>>
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.name).toBe('alpha')
    expect(candidates[0]?.provider).toBe(OVERLAY_PROVIDER)
    expect(candidates[0]?.rank).toBe(1)
    expect(candidates[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('serves the stored body with overlay flags', async () => {
    const provider = new OverlaySkillProvider([entry('alpha', false, true)])
    const definition = (await provider.get({ locator: { name: 'alpha' } })) as Record<string, unknown>
    expect(definition?.content).toBe('body of alpha')
    expect(definition?.path).toBe('/x/alpha')
    expect(definition?.provider).toBe(OVERLAY_PROVIDER)
    expect(definition?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('returns undefined for unknown names', async () => {
    const provider = new OverlaySkillProvider([entry('alpha', false, true)])
    expect(await provider.get({ locator: { name: 'missing' } })).toBeUndefined()
  })
})
