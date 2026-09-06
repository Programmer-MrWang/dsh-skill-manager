/**
 * Skill Manager host plugin — one Profile Bundle row.
 *
 * Registers the `skill-manager` settings namespace (version 1 policy
 * document), the `skillManager` Remote namespace, the scoped runtime overlay
 * engine, and the workspace-root tracking behind them. Every contribution is
 * owned by this plugin's Cordis fiber and unwinds with it.
 *
 * @module dsh-skill-manager
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the `settings`, `skills`, and `typert` Context merges.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SkillAuthoringService } from './authoring.js'
import {
  SkillManagerController,
  SkillManagerGateway,
  skillManagerContribution,
  type SkillManagerContextServices,
} from './remote.js'
import { SkillOverlayEngine, SkillPolicyStore, type SkillManagerSettings } from './runtime.js'
import { SETTINGS_NAMESPACE } from './wire.js'

export const name = 'skill-manager'

/** Required services; the row only activates where all three exist. */
export const inject = ['settings', 'skills', 'typert']

/** Settings namespace schema: the versioned policy document under one field. */
const ConfigSchema: Schema<SkillManagerSettings> = z.object({ policy: z.any() }) as Schema<SkillManagerSettings>

/**
 * Mount the Skill Manager.
 * @param ctx - Host context with settings, skills, and typert services.
 */
export function apply(ctx: Context): void {
  const scope = ctx.settings.register<typeof SETTINGS_NAMESPACE, SkillManagerSettings>(SETTINGS_NAMESPACE, ConfigSchema, {
    base: { policy: null },
    applies: 'live',
  })

  const store = new SkillPolicyStore(scope, {
    onDocumentChange: () => { engine.refreshAll() },
  })
  ctx.effect(() => () => { store.dispose() }, 'skill-manager: policy store')

  const authoring = createAuthoring(ctx)

  const engine = new SkillOverlayEngine(ctx, {
    settingsStore: store,
    skills: {
      list: options => ctx.skills.list(options as never),
      get: (name, options) => ctx.skills.get(name, options as never),
    },
    ...(ctx.get('agentPresets') === undefined ? {} : {
      presetOf: (agent: Agent) => composedPresetOf(ctx, agent.ctx),
    }),
  })
  engine.attach()

  const controller = new SkillManagerController(
    ctx,
    readControllerServices(ctx, engine),
    authoring,
    store,
  )
  // Register the Remote service: the Typert gateway dispatches namespace
  // endpoints onto this exact service key.
  new SkillManagerGateway(ctx, controller)

  ctx.effect(() => ctx.typert.register({
    package: 'dsh-skill-manager',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: skillManagerContribution().descriptors as never,
  }), 'skill-manager: host typert contribution')
  ctx.logger.info('[skill-manager] mounted (settings namespace %s)', SETTINGS_NAMESPACE)
}

/** Build the controller service closures from the optional registries. */
function readControllerServices(ctx: Context, engine: SkillOverlayEngine): SkillManagerContextServices {
  const agents = ctx.get('agents') as { readonly list: () => Agent[] } | undefined
  return {
    skills: {
      list: options => ctx.skills.list(options),
    },
    ...(agents === undefined ? {} : {
      agents: {
        list: () => agents.list(),
        get: id => agents.list().find(agent => String(agent.id) === id),
      },
    }),
    ...(ctx.get('agentPresets') === undefined ? {} : {
      presetOf: (agent: { ctx: Context }) => composedPresetOf(ctx, agent.ctx),
      presetList: async () => {
        const service = ctx.get('agentPresets') as { readonly list: () => Promise<Array<{ id: string; name?: string }>> }
        return await service.list()
      },
    }),
    baselineOf: sessionId => engine.baselineFor(sessionId),
  }
}

/** Resolve one Agent's preset identifier through the optional roster service. */
function composedPresetOf(ctx: Context, agentCtx: Context): string | undefined {
  const service = ctx.get('agentPresets') as { readonly composedPreset?: (agentCtx: Context) => string | undefined } | undefined
  try {
    return service?.composedPreset?.(agentCtx)
  } catch {
    return undefined
  }
}

/** Build the authoring service and keep its project roots in sync with live sessions. */
function createAuthoring(ctx: Context): SkillAuthoringService {
  const dshHome = resolveDshHome(undefined)
  const agentsHome = resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
  const authoring = new SkillAuthoringService({ dshHome, agentsHome, workspaceRoots: [] })
  const refreshWorkspaceRoots = (): void => {
    const agents = ctx.get('agents') as { readonly list: () => Agent[] } | undefined
    const roots: string[] = []
    const seen = new Set<string>()
    for (const agent of agents?.list() ?? []) {
      const cwd = agent.session.header.cwd
      if (cwd === undefined || seen.has(cwd)) continue
      seen.add(cwd)
      roots.push(cwd)
    }
    authoring.setWorkspaceRoots(roots)
  }
  refreshWorkspaceRoots()
  ctx.on('agent/created', refreshWorkspaceRoots)
  ctx.on('agent/disposed', refreshWorkspaceRoots)
  return authoring
}
