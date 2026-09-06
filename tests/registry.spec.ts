// Registry overlay semantics test: a scoped low-rank provider must shadow the
// neutral winner for the Agent scope and flip its invocation booleans, exactly
// as the SkillOverlayEngine installs it. Uses the real SkillRegistry.
// Run with: npx vitest run tests/registry.spec.ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

const summary = (flags: { modelInvocable: boolean; userInvocable: boolean }) => ({
  name: 'alpha',
  description: 'Does alpha things.',
  invocation: flags,
  source: 'user-dsh' as const,
  rank: 400,
  provider: 'filesystem' as const,
  locator: { name: 'alpha' },
})

describe('scoped overlay shadowing on the real registry', () => {
  it('lets an Agent-scope overlay tighten the winner and keep the name', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(() => ({
      name: 'filesystem',
      list: async () => [summary({ modelInvocable: true, userInvocable: true })],
      get: async () => ({
        name: 'alpha',
        description: 'Does alpha things.',
        content: 'Instructions.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-dsh',
        provider: 'filesystem',
      }),
    }))

    const agent = createScope(ctx, { agent: 'scope-1' })
    const agentSkills = agent.ctx.get('skills')
    if (agentSkills === undefined) throw new Error('skills service missing in scope')

    // The neutral view in the Agent scope sees the underlying winner.
    const before = await agentSkills.list({ scope: scopeOf(agent.ctx) })
    expect(before.map(skill => skill.name)).toEqual(['alpha'])
    expect(before[0]?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(isModelInvocable(before[0]!)).toBe(true)

    // The engine installs one overlay provider (rank 1) into the same scope.
    const dispose = agentSkills.registerProvider(() => ({
      name: 'skill-manager-policy',
      list: async () => [{
        name: 'alpha',
        description: 'Does alpha things.',
        invocation: { modelInvocable: false, userInvocable: false },
        source: 'user-dsh',
        rank: 1,
        provider: 'skill-manager-policy',
        locator: { name: 'alpha' },
      }],
      get: async () => ({
        name: 'alpha',
        description: 'Does alpha things.',
        content: 'Instructions.',
        invocation: { modelInvocable: false, userInvocable: false },
        source: 'user-dsh',
        provider: 'skill-manager-policy',
      }),
    }))

    const after = await agentSkills.list({ scope: scopeOf(agent.ctx) })
    expect(after).toHaveLength(1)
    expect(after[0]?.name).toBe('alpha')
    expect(after[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(isModelInvocable(after[0]!)).toBe(false)
    expect(after[0]?.description).toBe('Does alpha things.')

    // The global (no scope) view keeps the underlying winner untouched.
    const global = await ctx.skills.list({})
    expect(global[0]?.invocation).toEqual({ modelInvocable: true, userInvocable: true })

    // Removing the overlay restores the neutral view (engine swap semantics).
    dispose()
    const restored = await agentSkills.list({ scope: scopeOf(agent.ctx) })
    expect(restored[0]?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
  })
})
