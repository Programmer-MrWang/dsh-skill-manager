/**
 * Host policy persistence and the per-Agent runtime overlay that enforces it.
 *
 * `SkillPolicyStore` owns the version 1 policy document stored in the
 * `skill-manager` settings namespace: reads, watched commits, and one
 * serialized mutation queue with a monotonic revision for optimistic writes.
 *
 * `SkillOverlayEngine` keeps every live Agent's effective skill view equal to
 * its layered policy. Agent presets register their providers in the Agent's
 * own scope, so the engine swaps out its previous overlay, reads the neutral
 * winners in that same scope, shadows exactly the skills a policy tightens
 * with a low-rank provider (bodies captured at recompute), and repeats this
 * whenever policy, the catalog, or the session state changes.
 * Because the overlay candidate sits in the Agent scope, it wins the duplicate
 * name and can never reveal a lower-priority skill with the same name; the
 * existing invocation checks of the model catalog, the `skill` tool, `/name`
 * injection, and the Web slash menu all observe the same booleans.
 *
 * @module dsh-skill-manager/runtime
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillResourceBase, SkillSummary } from '@deepseek-ai/dsh-skill'
import { explainPolicy, normalizePolicy, validatePolicy } from './policy.js'
import type { PolicyContext, PolicyDocumentV1, PolicyMode, PolicyState } from './types.js'
import { CONFLICT_MESSAGE, POLICY_FIELD } from './wire.js'

/** Settings shape resolved for the manager namespace. */
export interface SkillManagerSettings {
  readonly policy: PolicyDocumentV1 | null
}

/** Settings handle the store writes through (structural subset of `SettingsScope`). */
export interface SkillPolicyStoreSink {
  readonly get: () => SkillManagerSettings
  readonly watch: (callback: (next: SkillManagerSettings, prev: SkillManagerSettings) => void) => () => void
  readonly update: (patch: { policy: PolicyDocumentV1 | null }) => Promise<void>
}

/** Change observer used by the overlay engine and the controller. */
export interface SkillPolicyStoreHooks {
  readonly onDocumentChange: () => void
}

/** CAS refusal thrown when a policy write is based on a stale read. */
export class SkillPolicyConflictError extends Error {
  readonly code = 'SETTINGS_CONFLICT'
  constructor() {
    super(CONFLICT_MESSAGE)
    this.name = 'SkillPolicyConflictError'
  }
}

/**
 * Own one persisted policy document with optimistic-write revisions.
 */
export class SkillPolicyStore {
  private document: PolicyDocumentV1 | null
  private revision = 0
  private tail: Promise<void> = Promise.resolve()
  private readonly disposeWatch: () => void

  /**
   * @param sink - resolved settings handle of the `skill-manager` namespace.
   * @param hooks - notified after every committed document change.
   */
  constructor(
    private readonly sink: SkillPolicyStoreSink,
    private readonly hooks: SkillPolicyStoreHooks,
  ) {
    this.document = snapshotOf(sink.get().policy)
    this.disposeWatch = sink.watch((next) => {
      this.document = snapshotOf(next.policy)
      this.revision += 1
      hooks.onDocumentChange()
    })
  }

  /** Stop observing the settings namespace. */
  dispose(): void {
    this.disposeWatch()
  }

  /** @returns the current detached policy document, or null when none is stored. */
  getDocument(): PolicyDocumentV1 | null {
    return snapshotOf(this.document)
  }

  /** @returns the current optimistic-write revision; snapshot sends it as the CAS precondition. */
  getRevision(): number {
    return this.revision
  }

  /**
   * Replace one policy layer and persist the document.
   * @param scope - layer to edit; `global` ignores `key`.
   * @param key - preset/workspace/session identifier for scoped layers.
   * @param mode - new layer mode; `null` removes the mode override.
   * @param states - per-skill overrides; `null` removes that skill entry.
   * @param expectedRevision - revision the caller read; a mismatch refuses the write.
   * @returns the committed revision and document.
   */
  async setLayer(
    scope: 'global' | 'preset' | 'workspace' | 'session',
    key: string | null,
    mode: PolicyMode | null,
    states: Readonly<Record<string, PolicyState | null>>,
    expectedRevision: number,
  ): Promise<{ revision: number; document: PolicyDocumentV1 | null }> {
    if (scope === 'global' ? key !== null : key === null || key.length === 0) {
      throw new TypeError('policy layer edit names an invalid scope key')
    }
    return await this.exclusive(async () => {
      if (expectedRevision !== this.revision) throw new SkillPolicyConflictError()
      const current = snapshotOf(this.document) ?? { version: 1 as const }
      const next = normalizePolicy(editLayer(current, scope, key, mode, states))
      const previous = this.document
      this.document = isEmptyDocument(next) ? null : snapshotOf(next)
      try {
        // The settings watcher also commits the revision and notifies the hooks;
        // this queue only serializes writes and refuses stale ones.
        if (this.document === null) await this.sink.update({ policy: null })
        else await this.sink.update({ policy: this.document })
      } catch (error) {
        this.document = previous
        throw error
      }
      return { revision: this.revision, document: this.getDocument() }
    })
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolveRelease => { release = resolveRelease })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

/** Fold one layer edit onto a document copy; empty layers and maps disappear. */
function editLayer(
  document: PolicyDocumentV1,
  scope: 'global' | 'preset' | 'workspace' | 'session',
  key: string | null,
  mode: PolicyMode | null,
  states: Readonly<Record<string, PolicyState | null>>,
): PolicyDocumentV1 {
  const next = structuredClone(document) as {
    version: 1
    global?: { mode?: PolicyMode; skills?: Record<string, PolicyState> }
    presets?: Record<string, { mode?: PolicyMode; skills?: Record<string, PolicyState> }>
    workspaces?: Record<string, { mode?: PolicyMode; skills?: Record<string, PolicyState> }>
    sessions?: Record<string, { mode?: PolicyMode; skills?: Record<string, PolicyState> }>
  }
  let layer: { mode?: PolicyMode; skills?: Record<string, PolicyState> }
  if (scope === 'global') {
    layer = next.global ?? (next.global = {})
  } else {
    const mapName = scope === 'preset' ? 'presets' : scope === 'workspace' ? 'workspaces' : 'sessions'
    const map = next[mapName] ?? (next[mapName] = {})
    layer = map[key as string] ?? (map[key as string] = {})
  }
  if (mode === null || mode === 'inherit') delete layer.mode
  else layer.mode = mode
  const skills = layer.skills ?? (layer.skills = {})
  for (const [name, state] of Object.entries(states)) {
    if (state === null || state === 'inherit') delete skills[name]
    else skills[name] = state
  }
  if (Object.keys(skills).length === 0) delete layer.skills
  const empty = Object.keys(layer).length === 0
  if (scope === 'global') {
    if (empty) delete next.global
  } else {
    const mapName = scope === 'preset' ? 'presets' : scope === 'workspace' ? 'workspaces' : 'sessions'
    const map = next[mapName]
    if (map !== undefined && empty) delete map[key as string]
  }
  return next as PolicyDocumentV1
}

/** Whether a normalized document carries no override anywhere. */
function isEmptyDocument(document: PolicyDocumentV1): boolean {
  const layerIsEmpty = (layer: { mode?: string; skills?: Record<string, unknown> } | undefined): boolean =>
    layer === undefined
    || (layer.mode === undefined || layer.mode === 'inherit') && Object.keys(layer.skills ?? {}).length === 0
  if (!layerIsEmpty(document.global)) return false
  return Object.keys(document.presets ?? {}).every(key =>
    layerIsEmpty(document.presets?.[key]))
    && Object.keys(document.workspaces ?? {}).every(key =>
      layerIsEmpty(document.workspaces?.[key]))
    && Object.keys(document.sessions ?? {}).every(key =>
      layerIsEmpty(document.sessions?.[key]))
}

/** Detach one policy document (or null); foreign or invalid stored values degrade to null. */
function snapshotOf(document: PolicyDocumentV1 | null | undefined): PolicyDocumentV1 | null {
  if (document === null || document === undefined) return null
  if (typeof document !== 'object' || Array.isArray(document)) return null
  const validation = validatePolicy(document)
  if (!validation.valid) return null
  return structuredClone(document) as PolicyDocumentV1
}

/** Underlying author facts captured from the Agent's neutral catalog. */
export interface OverlayBaselineSkill {
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}

/** One installed per-Agent overlay generation. */
interface AgentOverlay {
  readonly agent: Agent
  /** Canonical workspace key of the Agent's session. */
  readonly workspace: string | undefined
  /** Preset identifier recorded at attach time. */
  readonly preset: string | undefined
  /** Serialized signature of the last installed overlay; skips no-op refreshes. */
  signature: string
  /** Fiber owning the currently registered overlay provider. */
  fiber: ReturnType<Context['inject']> | undefined
  /** Serializes recompute work for this Agent. */
  queue: Promise<void>
  /** Author facts of the last neutral catalog (underlying winners). */
  baseline: ReadonlyMap<string, OverlayBaselineSkill>
}

/** Dependency closures the engine needs from its host plugin. */
export interface SkillOverlayEngineDependencies {
  readonly settingsStore: SkillPolicyStore
  readonly skills: {
    readonly list: (options: { scope?: unknown; cwd?: string }) => Promise<SkillSummary[]>
    readonly get: (
      name: string,
      options: { scope?: unknown; cwd?: string },
    ) => Promise<{ readonly content: string; readonly path?: string; readonly resourceBase?: SkillResourceBase } | undefined>
  }
  /** Reads the Agent's preset identifier; absent when the roster service is missing. */
  readonly presetOf?: (agent: Agent) => string | undefined
}

/**
 * Install policy-restricted skill copies into every live Agent's scope.
 */
export class SkillOverlayEngine {
  private readonly overlays = new Map<Agent, AgentOverlay>()
  private attached = false

  /**
   * @param ctx - Host context with agents, skills, and settings services.
   * @param dependencies - store and registry closures; registry reads below the Agent scope.
   */
  constructor(
    private readonly ctx: Context,
    private readonly dependencies: SkillOverlayEngineDependencies,
  ) {}

  /** Attach to every live Agent and start listening for future ones. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    const agents = this.ctx.get('agents') as
      | { readonly list: () => Agent[]; readonly get: (id: string) => Agent | undefined } | undefined
    if (agents !== undefined) {
      for (const agent of agents.list()) void this.attachAgent(agent)
      this.ctx.on('agent/created', ({ agent }: { agent: Agent }) => { void this.attachAgent(agent) })
      this.ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => { this.detachAgent(agent) })
    }
    this.ctx.on('skills/change', () => { this.refreshAll() })
    this.ctx.effect(() => () => {
      for (const overlay of [...this.overlays.values()]) {
        this.overlays.delete(overlay.agent)
        void overlay.fiber?.dispose()
      }
    }, 'skill-manager: overlay engine')
  }

  /** Recompute every attached overlay (policy, catalog, or roster changes). */
  refreshAll(): void {
    for (const overlay of this.overlays.values()) {
      overlay.queue = overlay.queue.then(
        () => this.recompute(overlay),
        () => this.recompute(overlay),
      )
    }
  }

  private async attachAgent(agent: Agent): Promise<void> {
    if (this.overlays.has(agent)) return
    const workspace = await workspaceKeyOf(agent)
    const overlay: AgentOverlay = {
      agent,
      workspace,
      preset: this.dependencies.presetOf?.(agent),
      signature: '',
      fiber: undefined,
      queue: Promise.resolve(),
      baseline: new Map(),
    }
    this.overlays.set(agent, overlay)
    overlay.queue = overlay.queue.then(() => this.recompute(overlay), () => this.recompute(overlay))
  }

  /** Underlying author facts for one live Agent (for the snapshot UI). */
  baselineFor(sessionId: string): ReadonlyMap<string, OverlayBaselineSkill> | undefined {
    for (const overlay of this.overlays.values()) {
      if (String(overlay.agent.id) === sessionId) return overlay.baseline
    }
    return undefined
  }

  private detachAgent(agent: Agent): void {
    const overlay = this.overlays.get(agent)
    if (overlay === undefined) return
    this.overlays.delete(agent)
    const fiber = overlay.fiber
    overlay.fiber = undefined
    if (fiber !== undefined) {
      void fiber.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(`skill-manager: overlay cleanup failed for ${agent.id}: ${messageOf(error)}`)
      })
    }
  }

  private async recompute(overlay: AgentOverlay): Promise<void> {
    const { agent, workspace, preset } = overlay
    const session = String(agent.id)
    const context: PolicyContext = {
      ...(preset === undefined ? {} : { preset }),
      ...(workspace === undefined ? {} : { workspace }),
      session,
    }
    const document = this.dependencies.settingsStore.getDocument()
    const alive = (): boolean => this.overlays.get(agent) === overlay

    // Preset rows register their providers in the Agent's own scope, so the
    // neutral view and the overlay share that layer. Drop the previous
    // overlay first: only then does an Agent-scope list see the underlying
    // winners instead of our own candidates.
    const previous = overlay.fiber
    overlay.fiber = undefined
    if (previous !== undefined) {
      try {
        await previous.dispose()
      } catch (error) {
        this.ctx.logger.warn(`skill-manager: overlay swap failed for ${session}: ${messageOf(error)}`)
        return
      }
    }
    if (!alive()) return

    let neutral: SkillSummary[]
    try {
      neutral = await this.dependencies.skills.list({
        scope: agent,
        cwd: agent.session.header.cwd,
      })
    } catch (error) {
      this.ctx.logger.warn(`skill-manager: neutral catalog read failed for ${session}: ${messageOf(error)}`)
      return
    }
    const baseline = new Map<string, OverlayBaselineSkill>()
    for (const skill of neutral) {
      baseline.set(skill.name, {
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: skill.source,
        invocation: {
          modelInvocable: skill.invocation.modelInvocable,
          userInvocable: skill.invocation.userInvocable,
        },
      })
    }
    overlay.baseline = baseline
    if (!alive()) return

    const restrictions = computeOverlayRestrictions(document, context, neutral)
    const entries: OverlaySkillEntry[] = []
    for (const restriction of restrictions) {
      let definition
      try {
        definition = await this.dependencies.skills.get(restriction.summary.name, {
          scope: agent,
          cwd: agent.session.header.cwd,
        })
      } catch (error) {
        this.ctx.logger.warn(`skill-manager: overlay body read failed for ${restriction.summary.name}: ${messageOf(error)}`)
        continue
      }
      if (definition === undefined) continue
      entries.push({
        summary: restriction.summary,
        model: restriction.model,
        user: restriction.user,
        content: definition.content,
        ...(definition.path === undefined ? {} : { path: definition.path }),
        ...(definition.resourceBase === undefined ? {} : { resourceBase: definition.resourceBase }),
      })
    }
    const signature = JSON.stringify([
      document,
      entries.map(({ summary, model, user }) => [summary.name, model, user]),
    ])
    if (signature === overlay.signature) return
    overlay.signature = signature
    if (!alive()) return
    if (entries.length === 0) return

    try {
      const provider = new OverlaySkillProvider(entries)
      const next = agent.ctx.inject(['skills'], (scope) => {
        scope.skills.registerProvider(() => provider as never)
      })
      overlay.fiber = next
      await next
    } catch (error) {
      overlay.signature = ''
      this.ctx.logger.warn(`skill-manager: overlay install failed for ${session}: ${messageOf(error)}`)
    }
  }
}

/** Provider name reserved for policy-restricted overlay candidates. */
export const OVERLAY_PROVIDER = 'skill-manager-policy'

/**
 * Compute the Agent-scope restrictions a policy requires over the neutral
 * winners: every skill whose effective invocation differs from its author's.
 * Pure and sync so the overlay engine and its tests share one decision.
 * @param document - stored policy document (null = no policy).
 * @param context - active preset/workspace/session selectors.
 * @param neutral - neutral winners below the Agent scope.
 * @returns per-skill final model/user booleans.
 */
export function computeOverlayRestrictions(
  document: PolicyDocumentV1 | null,
  context: PolicyContext,
  neutral: readonly SkillSummary[],
): Array<{ summary: SkillSummary; model: boolean; user: boolean }> {
  const restrictions: Array<{ summary: SkillSummary; model: boolean; user: boolean }> = []
  for (const summary of neutral) {
    const author = summary.invocation
    if (!author.modelInvocable && !author.userInvocable) continue
    const model = policyAllows(document, context, summary, 'model')
    const user = policyAllows(document, context, summary, 'user')
    if (model === author.modelInvocable && user === author.userInvocable) continue
    restrictions.push({ summary, model, user })
  }
  return restrictions
}

/** One restricted skill the overlay provider serves with a stored body. */
export interface OverlaySkillEntry {
  readonly summary: SkillSummary
  readonly model: boolean
  readonly user: boolean
  readonly content: string
  readonly path?: string
  readonly resourceBase?: SkillResourceBase
}

/**
 * Agent-scope provider that shadows restricted skill names with tighter
 * invocation flags. Bodies are captured at recompute time (the underlying
 * winners live in the same scope, so a live delegation would recurse).
 * Exported for direct unit tests; production use is the overlay engine.
 */
export class OverlaySkillProvider {
  readonly name = OVERLAY_PROVIDER
  private readonly byName = new Map<string, OverlaySkillEntry>()

  constructor(entries: readonly OverlaySkillEntry[]) {
    for (const entry of entries) this.byName.set(entry.summary.name, entry)
  }

  async list(): Promise<readonly unknown[]> {
    return [...this.byName.values()].map(entry => ({
      name: entry.summary.name,
      description: entry.summary.description,
      ...(entry.summary.whenToUse === undefined ? {} : { whenToUse: entry.summary.whenToUse }),
      invocation: { modelInvocable: entry.model, userInvocable: entry.user },
      source: entry.summary.source,
      rank: 1,
      provider: OVERLAY_PROVIDER,
      locator: { name: entry.summary.name },
    }))
  }

  async get(candidate: { locator: { name: string } }): Promise<unknown> {
    const entry = this.byName.get(candidate.locator.name)
    if (entry === undefined) return undefined
    return {
      name: entry.summary.name,
      description: entry.summary.description,
      ...(entry.summary.whenToUse === undefined ? {} : { whenToUse: entry.summary.whenToUse }),
      invocation: { modelInvocable: entry.model, userInvocable: entry.user },
      source: entry.summary.source,
      provider: OVERLAY_PROVIDER,
      content: entry.content,
      ...(entry.path === undefined ? {} : { path: entry.path }),
      ...(entry.resourceBase === undefined ? {} : { resourceBase: entry.resourceBase }),
    }
  }
}

/** Resolve the policy decision for one actor, treating an absent document as allow. */
function policyAllows(
  document: PolicyDocumentV1 | null,
  context: PolicyContext,
  summary: SkillSummary,
  actor: 'model' | 'user',
): boolean {
  if (document === null) {
    return actor === 'model' ? summary.invocation.modelInvocable : summary.invocation.userInvocable
  }
  return explainPolicy(document, {
    skill: summary.name,
    invocation: actor,
    author: summary.invocation,
    ...context,
  }).allowed
}

/** Canonical workspace identity for one Agent's session directory. */
export async function canonicalWorkspaceKeyOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined
  try {
    const canonical = await realpath(cwd)
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  } catch {
    return undefined
  }
}

/** Canonical workspace identity for one Agent. */
async function workspaceKeyOf(agent: Agent): Promise<string | undefined> {
  return await canonicalWorkspaceKeyOf(agent.session.header.cwd)
}

/** Render an arbitrary failure for a log line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { POLICY_FIELD }
