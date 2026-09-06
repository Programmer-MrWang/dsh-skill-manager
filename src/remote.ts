/**
 * Host controller and Typert Gateway for the `skillManager` Remote namespace.
 *
 * Every method returns detached JSON DTOs and maps domain failures onto the
 * stable `skill-manager/error` Remote code, so the browser never sees an
 * absolute path, a Cordis object, or an unclassified internal message.
 *
 * @module dsh-skill-manager/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { explainPolicy } from './policy.js'
import { SkillAuthoringError, type SkillAuthoringService } from './authoring.js'
import type { SkillPolicyStore } from './runtime.js'
import { canonicalWorkspaceKeyOf } from './runtime.js'
import type {
  AuthorInvocationPolicy,
  PolicyContext,
  PolicyDocumentV1,
  PolicyExplanation,
} from './types.js'
import {
  codec,
  invocation,
  METHODS,
  PACKAGE,
  parseDraft,
  parseImportRequest,
  parseSnapshotRequest,
  param,
  SERVICE,
  type SkillManagerSnapshot,
  type WireContribution,
  type WireDescriptor,
} from './wire.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Owner-side domain failure carrying the stable authoring code. */
    'skill-manager/error': { readonly code: string }
  }
}

/* ------------------------------ DTO codecs ------------------------------ */

const ROOT_VIEW = codec('RootView', (value: unknown) => value)
const TRASH_VIEW = codec('TrashView', (value: unknown) => value)
const DRAFT_RESULT = codec('DraftResult', (value: unknown) => value)
const VALIDATE_RESULT = codec('ValidateResult', (value: unknown) => value)
const SNAPSHOT = codec('Snapshot', (value: unknown) => value)
const SNAPSHOT_REQUEST = codec('SnapshotRequest', (value: unknown) => parseSnapshotRequest(value))
const DRAFT = codec('Draft', (value: unknown) => {
  void parseDraft(value)
  return value
})
const STRING = codec('String', (value: unknown) => {
  if (typeof value !== 'string') throw new Error('value must be a string')
  return value
})
const LAYOUT = codec('Layout', (value: unknown) => {
  if (value !== 'bundle' && value !== 'flat') throw new Error('layout must be bundle or flat')
  return value
})
const OK = codec('Ok', (value: unknown) => {
  if (value !== 'ok') throw new Error('expected ok')
  return value
})
const SET_LAYER_REQUEST = codec('SetLayerRequest', (value: unknown) => parseLayerRequest(value))
const POLICY_WRITE = codec('PolicyWrite', (value: unknown) => value)
const IMPORT_REQUEST = codec('ImportRequest', (value: unknown) => parseImportRequest(value))
const IMPORT_RESULT = codec('ImportResult', (value: unknown) => value)

/** Wire descriptors for the whole `skillManager` namespace. */
export function skillManagerDescriptors(): readonly WireDescriptor[] {
  return [
    invocation('snapshot', [param('request', SNAPSHOT_REQUEST)], SNAPSHOT),
    invocation('readDraft', [param('candidateId', STRING)], DRAFT_RESULT),
    invocation('validateDraft', [param('draft', DRAFT)], VALIDATE_RESULT),
    invocation('create', [param('rootId', STRING), param('draft', DRAFT), param('layout', LAYOUT)], DRAFT_RESULT),
    invocation('update', [param('candidateId', STRING), param('expectedVersion', STRING), param('draft', DRAFT)], DRAFT_RESULT),
    invocation('copy', [param('candidateId', STRING), param('rootId', STRING), param('newName', STRING)], DRAFT_RESULT),
    invocation('trash', [param('candidateId', STRING), param('expectedVersion', STRING)], TRASH_VIEW),
    invocation('restore', [param('trashId', STRING)], DRAFT_RESULT),
    invocation('deletePermanently', [param('trashId', STRING)], OK),
    invocation('setLayer', [param('request', SET_LAYER_REQUEST)], POLICY_WRITE),
    invocation('importFolders', [param('request', IMPORT_REQUEST)], IMPORT_RESULT),
  ]
}

/** Client contribution mounting the whole namespace. */
export function skillManagerContribution(): WireContribution {
  return { package: PACKAGE, descriptors: skillManagerDescriptors() }
}

/* ------------------------------- Context -------------------------------- */

/** Live-session services the controller reads through. */
export interface SkillManagerContextServices {
  readonly skills: {
    readonly list: (options: { scope?: ScopeKey; cwd?: string }) => Promise<SkillSummary[]>
  }
  readonly agents?: {
    readonly list: () => SkillManagerLiveAgent[]
    readonly get: (id: string) => SkillManagerLiveAgent | undefined
  }
  readonly presetOf?: (agent: SkillManagerLiveAgent) => string | undefined
  readonly presetList?: () => Promise<Array<{ id: string; name?: string }>>
  /** Underlying author facts captured by the overlay engine for a live Agent. */
  readonly baselineOf?: (sessionId: string) => ReadonlyMap<string, import('./runtime.js').OverlayBaselineSkill> | undefined
}

/** Structural subset of the live Agent handle the controller reads. */
export interface SkillManagerLiveAgent {
  readonly id: unknown
  readonly ctx: Context
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** Resolved view context for one snapshot request. */
interface ResolvedView {
  readonly context: PolicyContext
  /** Scope used for the neutral registry read; absent reads the global view. */
  readonly scope?: ScopeKey
  readonly cwd?: string
  /** Whether this view corresponds to a live Agent (its scope owns overlays). */
  readonly liveAgent?: SkillManagerLiveAgent
}

/* ------------------------------- Controller ----------------------------- */

/** Business owner of every Remote method. */
export class SkillManagerController {
  /**
   * @param _ctx - Host context (service reads only).
   * @param services - live-session services.
   * @param authoring - filesystem authoring service.
   * @param store - persisted policy store.
   */
  constructor(
    _ctx: Context,
    private readonly services: SkillManagerContextServices,
    private readonly authoring: SkillAuthoringService,
    private readonly store: SkillPolicyStore,
  ) {}

  async snapshot(request: unknown): Promise<SkillManagerSnapshot> {
    const parsed = parseSnapshotRequest(request)
    const view = await this.resolveView(parsed.scope, parsed.id)
    const [roots, candidates, trash, scopeOptions, neutral, baseline, document] = await Promise.all([
      this.authoring.listRoots(),
      this.authoring.listCandidates(),
      this.authoring.listTrash(),
      this.listScopeOptions(),
      this.listNeutral(view),
      Promise.resolve(
        view.liveAgent === undefined
          ? undefined
          : this.services.baselineOf?.(String(view.liveAgent.id))),
      Promise.resolve(this.store.getDocument()),
    ])
    return {
      roots,
      candidates: candidates.map(candidate => toCandidateView(candidate)),
      effective: neutral.map(summary => this.buildEffective(summary, baseline, document, view)),
      trash: trash.map(item => ({
        id: item.id,
        name: item.name,
        rootId: item.rootId,
        layout: item.layout,
        deletedAt: item.deletedAt,
      })),
      scopeOptions: scopeOptions.map(option => ({
        scope: option.scope,
        id: option.id,
        ...(option.label === undefined ? {} : { label: option.label }),
      })),
      document,
      context: view.context,
      revision: this.store.getRevision(),
    }
  }

  async readDraft(candidateId: string): Promise<unknown> {
    const view = await this.authoring.readCandidate(candidateId)
    return draftResultOf(view)
  }

  async validateDraft(draft: unknown): Promise<unknown> {
    const parsed = parseDraft(draft)
    return { diagnostics: this.authoring.validateDraft(toAuthoringDraft(parsed)) }
  }

  async create(rootId: string, draft: unknown, layout: unknown): Promise<unknown> {
    const parsed = parseDraft(draft)
    const result = await this.authoring.create(rootId, toAuthoringDraft(parsed), layout as 'bundle' | 'flat')
    return draftResultOf(result)
  }

  async update(candidateId: string, expectedVersion: string, draft: unknown): Promise<unknown> {
    const parsed = parseDraft(draft)
    const result = await this.authoring.update(candidateId, expectedVersion, toAuthoringDraft(parsed))
    return draftResultOf(result)
  }

  async copy(candidateId: string, rootId: string, newName: string): Promise<unknown> {
    const result = await this.authoring.copy(candidateId, rootId, newName)
    return draftResultOf(result)
  }

  async trash(candidateId: string, expectedVersion: string): Promise<unknown> {
    const result = await this.authoring.trash(candidateId, expectedVersion)
    return { id: result.id, name: result.name, rootId: result.rootId, layout: result.layout, deletedAt: result.deletedAt }
  }

  async restore(trashId: string): Promise<unknown> {
    const result = await this.authoring.restore(trashId)
    return draftResultOf(result)
  }

  async deletePermanently(trashId: string): Promise<unknown> {
    await this.authoring.deletePermanently(trashId)
    return 'ok'
  }

  async setLayer(request: unknown): Promise<unknown> {
    const parsed = parseLayerRequest(request)
    const result = await this.store.setLayer(
      parsed.scope,
      parsed.key,
      parsed.mode,
      parsed.states,
      parsed.expectedRevision,
    )
    return { revision: result.revision, document: result.document }
  }

  async importFolders(request: unknown): Promise<unknown> {
    const parsed = parseImportRequest(request)
    const result = await this.authoring.importFromDirectories(parsed.paths, parsed.rootId)
    return {
      items: result.items.map(item => ({
        index: item.index,
        ...(item.name === undefined ? {} : { name: item.name }),
        status: item.status,
        ...(item.diagnostics === undefined ? {} : { diagnostics: item.diagnostics }),
      })),
      imported: result.imported,
    }
  }

  /* ------------------------- internal resolution ------------------------ */

  private async resolveView(scope?: string, id?: string): Promise<ResolvedView> {
    const agents = this.services.agents
    const live = await this.selectAgent(agents, scope, id)
    if (live !== undefined) {
      const cwd = live.session.header.cwd
      const workspace = await canonicalWorkspaceKeyOf(cwd)
      return {
        context: {
          ...(this.services.presetOf?.(live) === undefined ? {} : { preset: this.services.presetOf(live) as string }),
          ...(workspace === undefined ? {} : { workspace }),
          session: String(live.id),
        },
        scope: live.ctx as unknown as ScopeKey,
        cwd,
        liveAgent: live,
      }
    }
    if (scope === 'preset') {
      return { context: { preset: id ?? '' }, liveAgent: undefined }
    }
    if (scope === 'workspace') {
      return { context: { workspace: id ?? '' }, liveAgent: undefined }
    }
    return { context: { session: id }, liveAgent: undefined }
  }

  private async selectAgent(
    agents: SkillManagerContextServices['agents'],
    scope: string | undefined,
    id: string | undefined,
  ): Promise<SkillManagerLiveAgent | undefined> {
    if (agents === undefined) return undefined
    if (scope === undefined || scope === 'session') {
      if (id === undefined) return agents.list()[0]
      return agents.get(id)
    }
    if (scope === 'preset') {
      const preset = id ?? ''
      return agents.list().find(agent => this.services.presetOf?.(agent) === preset)
    }
    if (scope === 'workspace') {
      const workspace = id ?? ''
      for (const agent of agents.list()) {
        const key = await canonicalWorkspaceKeyOf(agent.session.header.cwd)
        if (key === workspace) return agent
      }
      return undefined
    }
    return undefined
  }

  private async listNeutral(view: ResolvedView): Promise<SkillSummary[]> {
    // A live Agent view reads the Agent's own scope, where preset rows mount
    // their providers and the overlay shadows restricted names.
    return await this.services.skills.list({ scope: view.scope, cwd: view.cwd })
  }

  private buildEffective(
    summary: SkillSummary,
    baseline: ReadonlyMap<string, import('./runtime.js').OverlayBaselineSkill> | undefined,
    document: PolicyDocumentV1 | null,
    view: ResolvedView,
  ): import('./wire.js').EffectiveSkillView {
    const context = view.context
    // The overlay winner's summary already carries the policy flags; the
    // engine-captured baseline restores the underlying author facts.
    const author = baseline?.get(summary.name)?.invocation ?? summary.invocation
    const flags = summary.invocation
    const authorSummary = { ...summary, invocation: author }
    const row: import('./wire.js').EffectiveSkillView = {
      name: summary.name,
      description: summary.description,
      ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
      source: summary.source,
      provider: summary.provider,
      author,
      effective: true,
      model: explanationFor(document, context, authorSummary, 'model'),
      user: explanationFor(document, context, authorSummary, 'user'),
    }
    if (flags.modelInvocable === author.modelInvocable && flags.userInvocable === author.userInvocable) {
      return row
    }
    return {
      ...row,
      effectiveInvocation: {
        modelInvocable: flags.modelInvocable,
        userInvocable: flags.userInvocable,
      },
    }
  }

  private async listScopeOptions(): Promise<Array<{ scope: 'preset' | 'workspace' | 'session'; id: string; label?: string }>> {
    const options: Array<{ scope: 'preset' | 'workspace' | 'session'; id: string; label?: string }> = []
    if (this.services.presetList !== undefined) {
      try {
        for (const preset of await this.services.presetList()) {
          options.push({ scope: 'preset', id: preset.id, ...(preset.name === undefined ? {} : { label: preset.name }) })
        }
      } catch {
        // A missing or broken roster service only narrows the picker.
      }
    }
    if (this.services.agents !== undefined) {
      const seen = new Set<string>()
      for (const agent of this.services.agents.list()) {
        options.push({ scope: 'session', id: String(agent.id) })
        const workspace = await canonicalWorkspaceKeyOf(agent.session.header.cwd)
        if (workspace !== undefined && !seen.has(workspace)) {
          seen.add(workspace)
          options.push({ scope: 'workspace', id: workspace })
        }
      }
    }
    return options
  }
}

/* ------------------------------- Gateway -------------------------------- */

/** Remote methods exposed by the `skillManager` namespace. */
export class SkillManagerGateway extends TypertRemoteService {
  /**
   * @param ctx - Host context.
   * @param controller - business owner of every method.
   */
  constructor(ctx: Context, controller: SkillManagerController) {
    super(ctx, SERVICE)
    this.controller = controller
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  private readonly controller: SkillManagerController

  snapshot(request: unknown): Promise<unknown> {
    return this.invoke('snapshot', () => this.controller.snapshot(request))
  }
  readDraft(candidateId: string): Promise<unknown> {
    return this.invoke('readDraft', () => this.controller.readDraft(candidateId))
  }
  validateDraft(draft: unknown): Promise<unknown> {
    return this.invoke('validateDraft', () => this.controller.validateDraft(draft))
  }
  create(rootId: string, draft: unknown, layout: unknown): Promise<unknown> {
    return this.invoke('create', () => this.controller.create(rootId, draft, layout))
  }
  update(candidateId: string, expectedVersion: string, draft: unknown): Promise<unknown> {
    return this.invoke('update', () => this.controller.update(candidateId, expectedVersion, draft))
  }
  copy(candidateId: string, rootId: string, newName: string): Promise<unknown> {
    return this.invoke('copy', () => this.controller.copy(candidateId, rootId, newName))
  }
  trash(candidateId: string, expectedVersion: string): Promise<unknown> {
    return this.invoke('trash', () => this.controller.trash(candidateId, expectedVersion))
  }
  restore(trashId: string): Promise<unknown> {
    return this.invoke('restore', () => this.controller.restore(trashId))
  }
  deletePermanently(trashId: string): Promise<unknown> {
    return this.invoke('deletePermanently', () => this.controller.deletePermanently(trashId))
  }
  setLayer(request: unknown): Promise<unknown> {
    return this.invoke('setLayer', () => this.controller.setLayer(request))
  }
  importFolders(request: unknown): Promise<unknown> {
    return this.invoke('importFolders', () => this.controller.importFolders(request))
  }

  /** Run one method and fold every domain failure onto the stable Remote code. */
  private async invoke(method: string, operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation()
    } catch (error) {
      throw toRemoteError(method, error)
    }
  }
}

const remoteInitializers: Array<(this: SkillManagerGateway) => void> = []
function markRemote(method: string): void {
  // Runtime equivalent of the standard `@Remote` decorator. Invoking the real
  // decorator with a fabricated standard-decorator context records the method
  // marker through the same addInitializer path the compiler would use, which
  // keeps one marking implementation for the Host and Client toolchains.
  const decorator = Remote(method)
  decorator(
    SkillManagerGateway.prototype[method as keyof SkillManagerGateway] as never,
    {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer(initializer: () => void) {
        remoteInitializers.push(initializer)
      },
    } as never,
  )
}
for (const method of METHODS) markRemote(method)

/* -------------------------------- Mapping ------------------------------- */

/** Map any domain failure onto a RemoteError with the stable manager code. */
function toRemoteError(method: string, error: unknown): RemoteError {
  if (error instanceof SkillAuthoringError) {
    return new RemoteError('skill-manager/error', `${method}: ${error.message}`, { code: error.code })
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'SETTINGS_CONFLICT' || code === 'SkillPolicyConflictError' || code === 'CONFLICT') {
    return new RemoteError('skill-manager/error', `${method}: ${messageOf(error)}`, { code: 'CONFLICT' })
  }
  if (error instanceof TypeError
    || (error instanceof Error && error.message.startsWith(`${PACKAGE} wire:`))) {
    return new RemoteError('skill-manager/error', `${method}: ${messageOf(error)}`, { code: 'INVALID_INPUT' })
  }
  return new RemoteError('skill-manager/error', `${method}: ${messageOf(error)}`, { code: 'UNAVAILABLE' })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Detached JSON projection of one filesystem candidate. */
function toCandidateView(candidate: {
  id: string
  name: string
  description: string
  whenToUse?: string
  source: import('./wire.js').SkillCandidateView['source']
  provider: string
  rootId: string
  layout: 'bundle' | 'flat'
  editable: boolean
  deletable: boolean
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
  version?: string
  diagnostics: readonly { code: string; message: string }[]
}): import('./wire.js').SkillCandidateView {
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    source: candidate.source,
    provider: candidate.provider,
    rootId: candidate.rootId,
    layout: candidate.layout,
    editable: candidate.editable,
    deletable: candidate.deletable,
    invocation: candidate.invocation ?? { modelInvocable: true, userInvocable: true },
    ...(candidate.version === undefined ? {} : { version: candidate.version }),
    diagnostics: candidate.diagnostics,
  }
}

/** Detached JSON projection of one author draft. */
function toDraftView(draft: {
  name: string
  description: string
  whenToUse?: string
  invocation?: Partial<AuthorInvocationPolicy>
  metadata?: Readonly<Record<string, unknown>>
  frontmatter?: Readonly<Record<string, unknown>>
  body: string
}): Record<string, unknown> {
  return {
    name: draft.name,
    description: draft.description,
    ...(draft.whenToUse === undefined ? {} : { whenToUse: draft.whenToUse }),
    ...(draft.invocation === undefined ? {} : { invocation: draft.invocation }),
    ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
    ...(draft.frontmatter === undefined ? {} : { frontmatter: draft.frontmatter }),
    body: draft.body,
  }
}

/** Convert a wire draft into the authoring service's draft contract. */
function toAuthoringDraft(draft: {
  name: string
  description: string
  whenToUse?: string
  invocation?: Partial<AuthorInvocationPolicy>
  metadata?: Readonly<Record<string, unknown>>
  frontmatter?: Readonly<Record<string, unknown>>
  body: string
}): {
  name: string
  description: string
  whenToUse?: string
  invocation?: Partial<AuthorInvocationPolicy>
  metadata?: Record<string, unknown>
  frontmatter?: Record<string, unknown>
  body: string
} {
  return {
    name: draft.name,
    description: draft.description,
    ...(draft.whenToUse === undefined ? {} : { whenToUse: draft.whenToUse }),
    ...(draft.invocation === undefined ? {} : { invocation: draft.invocation }),
    ...(draft.metadata === undefined ? {} : { metadata: { ...draft.metadata } }),
    ...(draft.frontmatter === undefined ? {} : { frontmatter: { ...draft.frontmatter } }),
    body: draft.body,
  }
}

/** Project one authoring result onto the wire draft-result DTO. */
function draftResultOf(result: {
  candidate: Parameters<typeof toCandidateView>[0]
  draft: Parameters<typeof toDraftView>[0]
  version: string
  diagnostics: readonly { code: string; message: string }[]
}): Record<string, unknown> {
  return {
    candidate: toCandidateView(result.candidate),
    draft: toDraftView(result.draft),
    version: result.version,
    diagnostics: result.diagnostics,
  }
}

/** Resolve one policy explanation (an absent document behaves as default-all). */
function explanationFor(
  document: PolicyDocumentV1 | null,
  context: PolicyContext,
  summary: SkillSummary,
  actor: 'model' | 'user',
): PolicyExplanation {
  return explainPolicy(document ?? { version: 1 }, {
    skill: summary.name,
    invocation: actor,
    author: summary.invocation,
    ...context,
  })
}

/** Parse a setLayer request. */
function parseLayerRequest(value: unknown): {
  scope: 'global' | 'preset' | 'workspace' | 'session'
  key: string | null
  mode: 'inherit' | 'all' | 'allow-list' | 'deny-list' | null
  states: Readonly<Record<string, 'inherit' | 'allow' | 'deny' | null>>
  expectedRevision: number
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('setLayer request must be an object')
  }
  const v = value as Record<string, unknown>
  const scope = v.scope
  if (scope !== 'global' && scope !== 'preset' && scope !== 'workspace' && scope !== 'session') {
    throw new TypeError('setLayer request.scope is invalid')
  }
  let key: string | null
  if (v.key === null) key = null
  else if (typeof v.key === 'string') key = v.key
  else throw new TypeError('setLayer request.key must be a string or null')
  if (scope === 'global') {
    if (key !== null) throw new TypeError('setLayer request.key is invalid for the selected scope')
  } else if (key === null || key.length === 0) {
    throw new TypeError('setLayer request.key is invalid for the selected scope')
  }
  const mode = v.mode === null ? null : v.mode === 'inherit' || v.mode === 'all' || v.mode === 'allow-list' || v.mode === 'deny-list'
    ? v.mode
    : undefined
  if (mode === undefined) throw new TypeError('setLayer request.mode is invalid')
  const states: Record<string, 'inherit' | 'allow' | 'deny' | null> = {}
  if (v.states !== undefined) {
    if (v.states === null || typeof v.states !== 'object' || Array.isArray(v.states)) {
      throw new TypeError('setLayer request.states must be an object')
    }
    for (const [name, state] of Object.entries(v.states as Record<string, unknown>)) {
      if (state === null || state === 'inherit' || state === 'allow' || state === 'deny') {
        states[name] = state as 'inherit' | 'allow' | 'deny' | null
      } else {
        throw new TypeError(`setLayer request.states.${name} is invalid`)
      }
    }
  }
  const expectedRevision = v.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isFinite(expectedRevision)) {
    throw new TypeError('setLayer request.expectedRevision must be a number')
  }
  return { scope: scope as 'global' | 'preset' | 'workspace' | 'session', key, mode, states, expectedRevision }
}
