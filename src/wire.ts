/**
 * Wire contract shared by the Host gateway and the browser page: detached JSON
 * DTOs, strict codecs, Remote descriptors, and the stable failure vocabulary.
 *
 * This module is deliberately dependency-free and browser-safe. The Host
 * gateway and the Client bundle each embed their own copy through the bundler;
 * never import Node, Cordis, or service packages from here.
 *
 * @module dsh-skill-manager/wire
 */

import type {
  AuthorInvocationPolicy,
  PolicyContext,
  PolicyDocumentV1,
  PolicyExplanation,
  PolicyLayer,
  PolicyMode,
  PolicyState,
} from './types.js'

/** One writable or read-only skill root. */
export interface SkillRootView {
  readonly id: string
  readonly kind: 'user-dsh' | 'user-agents' | 'workspace-dsh' | 'workspace-agents'
  readonly label: string
  readonly writable: boolean
  readonly available: boolean
}

/** One diagnostic attached to a candidate or draft. */
export interface SkillDiagnosticView {
  readonly code: string
  readonly message: string
}

/** One filesystem candidate or editable skill. */
export interface SkillCandidateView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: SkillRootView['kind']
  readonly provider: string
  readonly rootId: string
  readonly layout: 'bundle' | 'flat'
  readonly editable: boolean
  readonly deletable: boolean
  /** Author invocation controls read from the skill's frontmatter. */
  readonly invocation: AuthorInvocationPolicy
  readonly version?: string
  readonly diagnostics: readonly SkillDiagnosticView[]
}

/** Author-form draft bound to one candidate. */
export interface SkillDraftView {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Author invocation controls; omitted keys default to true on write. */
  readonly invocation?: Partial<AuthorInvocationPolicy>
  /** Structured `metadata` mapping preserved by the editor. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Extra frontmatter keys the editor must keep verbatim. */
  readonly frontmatter?: Readonly<Record<string, unknown>>
  /** Markdown instruction body. */
  readonly body: string
}

/** One recoverable trash entry. */
export interface TrashView {
  readonly id: string
  readonly name: string
  readonly rootId: string
  readonly layout: 'bundle' | 'flat'
  readonly deletedAt: string
}

/** Scope options surfaced to the Policies view. */
export interface PolicyScopeOption {
  readonly scope: 'preset' | 'workspace' | 'session'
  readonly id: string
  readonly label?: string
}

/** One skill's effective status for the selected policy context. */
export interface EffectiveSkillView {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly provider: string
  /** Author invocation controls from the neutral winner. */
  readonly author: AuthorInvocationPolicy
  /** Whether this skill is the effective winner for the selected context. */
  readonly effective: boolean
  /** When not effective: the winning skill's description of itself. */
  readonly shadowedBy?: string
  /** Model and user policy explanations in this context. */
  readonly model: PolicyExplanation
  readonly user: PolicyExplanation
  /** Live effective booleans when a policy overlay tightened the author's flags. */
  readonly effectiveInvocation?: AuthorInvocationPolicy
}

/** Context selector sent by the Policies view. */
export interface SnapshotRequest {
  /** Layer the view resolves; absent selects the default live Agent context. */
  readonly scope?: 'preset' | 'workspace' | 'session'
  /** Preset/workspace/session identifier for the selected layer. */
  readonly id?: string
}

/** Complete snapshot rendered by the installed and policy views. */
export interface SkillManagerSnapshot {
  readonly roots: readonly SkillRootView[]
  readonly candidates: readonly SkillCandidateView[]
  readonly effective: readonly EffectiveSkillView[]
  readonly trash: readonly TrashView[]
  readonly scopeOptions: readonly PolicyScopeOption[]
  readonly document: PolicyDocumentV1 | null
  /** Canonical workspace and session keys of the page's fallback context. */
  readonly context: PolicyContext
  /** Optimistic-write revision returned by setLayer. */
  readonly revision: number
}

/** Readied draft for the editor. */
export interface SkillDraftResult {
  readonly candidate?: SkillCandidateView
  readonly draft: SkillDraftView
  readonly version?: string
  readonly diagnostics: readonly SkillDiagnosticView[]
}

/** Validation-only answer for a draft that has not been written. */
export interface SkillValidateResult {
  readonly diagnostics: readonly SkillDiagnosticView[]
}

/** One folder of an import request: absolute source path plus destination root. */
export interface SkillImportRequest {
  readonly paths: readonly string[]
  readonly rootId: string
}

/** Per-folder import outcome. */
export interface SkillImportItemView {
  readonly index: number
  readonly name?: string
  readonly status: 'imported' | 'conflict' | 'invalid' | 'error'
  readonly diagnostics?: readonly SkillDiagnosticView[]
}

/** Complete folder-import result. */
export interface SkillImportResult {
  readonly items: readonly SkillImportItemView[]
  readonly imported: number
}

/** Stable failure codes mapped onto RemoteError details. */
export type SkillManagerErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'CONTAINMENT_REFUSED'
  | 'TOO_LARGE'
  | 'UNAVAILABLE'

/** Remote method names, shared by the Host gateway and the browser descriptors. */
export const METHODS = [
  'snapshot',
  'readDraft',
  'validateDraft',
  'create',
  'update',
  'copy',
  'trash',
  'restore',
  'deletePermanently',
  'setLayer',
  'importFolders',
] as const
export type SkillManagerMethod = (typeof METHODS)[number]

/** Browser and Host package identities (single installable Profile Bundle). */
export const PACKAGE = 'dsh-skill-manager'
export const SERVICE = 'skillManager'

/** Settings namespace that persists the version 1 policy document. */
export const SETTINGS_NAMESPACE = 'skill-manager'
/** Settings field holding the policy document inside the namespace. */
export const POLICY_FIELD = 'policy'

/** Error text prefix parsed by the page to recognize transport-level losses. */
export const CONFLICT_MESSAGE = 'The skill changed after it was read'

/* ------------------------------ primitive parsers ------------------------------ */

/** Render one parse failure as a stable Error. */
export function fail(message: string): never {
  throw new Error(`${PACKAGE} wire: ${message}`)
}

/** Parse one detached JSON value strictly. */
export function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

/** @param value - candidate string. @param label - human label used in failure messages. @returns the value. */
export function parseString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  return value
}

/** @param value - candidate boolean. @param label - human label used in failure messages. @returns the value. */
export function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

/** @param value - candidate array. @param label - human label used in failure messages. @returns the entries. */
export function parseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

/** Parse a finite number. */
export function parseNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value
}

/** Parse one object allowing only the declared keys. */
export function parseKnown(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = parseRecord(value, label)
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(`${label}.${key} is not an allowed field`)
  }
  return record
}

/** Parse an untrusted generic mapping (any JSON-compatible entries). */
export function parseMapping(value: unknown, label: string): Record<string, unknown> {
  const record = parseRecord(value, label)
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, entry]))
}

/* ---------------------------- Draft parsing ---------------------------- */

const DRAFT_KEYS = ['name', 'description', 'whenToUse', 'invocation', 'metadata', 'frontmatter', 'body']

/** Parse an untrusted editor draft. */
export function parseDraft(value: unknown): SkillDraftView {
  const v = parseKnown(value, 'draft', DRAFT_KEYS)
  let invocationValue: Partial<AuthorInvocationPolicy> | undefined
  if (v.invocation !== undefined) {
    const inv = parseKnown(v.invocation, 'draft.invocation', ['modelInvocable', 'userInvocable'])
    const model = inv.modelInvocable === undefined
      ? undefined
      : parseBoolean(inv.modelInvocable, 'draft.invocation.modelInvocable')
    const user = inv.userInvocable === undefined
      ? undefined
      : parseBoolean(inv.userInvocable, 'draft.invocation.userInvocable')
    if (model !== undefined || user !== undefined) {
      invocationValue = {
        ...(model === undefined ? {} : { modelInvocable: model }),
        ...(user === undefined ? {} : { userInvocable: user }),
      }
    }
  }
  const whenToUse = v.whenToUse === undefined ? undefined : parseString(v.whenToUse, 'draft.whenToUse')
  const metadata = v.metadata === undefined ? undefined : parseMapping(v.metadata, 'draft.metadata')
  const frontmatter = v.frontmatter === undefined ? undefined : parseMapping(v.frontmatter, 'draft.frontmatter')
  return {
    name: parseString(v.name, 'draft.name'),
    description: parseString(v.description, 'draft.description'),
    body: parseString(v.body, 'draft.body'),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(invocationValue === undefined ? {} : { invocation: invocationValue }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(frontmatter === undefined ? {} : { frontmatter }),
  }
}

/* --------------------------- Policy parsing ---------------------------- */

const POLICY_STATES: readonly PolicyState[] = ['inherit', 'allow', 'deny']
const POLICY_MODES: readonly PolicyMode[] = ['inherit', 'all', 'allow-list', 'deny-list']

/** Parse one untrusted policy layer into a narrowed plain shape. */
export function parsePolicyLayer(value: unknown, label: string): { mode?: PolicyMode; skills?: Record<string, PolicyState> } {
  const v = parseKnown(value, label, ['mode', 'skills'])
  let mode: PolicyMode | undefined
  if (v.mode !== undefined) {
    if (typeof v.mode !== 'string' || !POLICY_MODES.includes(v.mode as PolicyMode)) {
      fail(`${label}.mode must be inherit, all, allow-list, or deny-list`)
    }
    mode = v.mode as PolicyMode
  }
  let skills: Record<string, PolicyState> | undefined
  if (v.skills !== undefined) {
    const raw = parseRecord(v.skills, `${label}.skills`)
    skills = {}
    for (const [name, state] of Object.entries(raw)) {
      if (typeof state !== 'string' || !POLICY_STATES.includes(state as PolicyState)) {
        fail(`${label}.skills.${name} must be inherit, allow, or deny`)
      }
      if (state !== 'inherit') skills[name] = state as Exclude<PolicyState, 'inherit'>
    }
  }
  return {
    ...(mode === undefined || mode === 'inherit' ? {} : { mode }),
    ...(skills === undefined || Object.keys(skills).length === 0 ? {} : { skills }),
  }
}

/** Parse one untrusted scope-keyed layer map. */
export function parseLayerMap(
  value: unknown,
  field: string,
): Record<string, { mode?: PolicyMode; skills?: Record<string, PolicyState> }> {
  const record = parseRecord(value, `policy document.${field}`)
  const out: Record<string, { mode?: PolicyMode; skills?: Record<string, PolicyState> }> = {}
  for (const key of Object.keys(record)) {
    if (key.length === 0) fail(`policy document.${field} contains an empty key`)
    const layer = parsePolicyLayer(record[key], `policy document.${field}.${key}`)
    if (Object.keys(layer).length > 0) out[key] = layer
  }
  return out
}

/** Parse one untrusted version 1 policy document. */
export function parsePolicyDocument(value: unknown): PolicyDocumentV1 {
  const v = parseKnown(value, 'policy document', ['version', 'global', 'presets', 'workspaces', 'sessions'])
  if (v.version !== 1) fail('policy document version must be 1')
  const global = v.global === undefined ? undefined : parsePolicyLayer(v.global, 'policy document.global')
  const presets = v.presets === undefined ? undefined : parseLayerMap(v.presets, 'presets')
  const workspaces = v.workspaces === undefined ? undefined : parseLayerMap(v.workspaces, 'workspaces')
  const sessions = v.sessions === undefined ? undefined : parseLayerMap(v.sessions, 'sessions')
  return {
    version: 1,
    ...(global === undefined || Object.keys(global).length === 0 ? {} : { global }),
    ...(presets === undefined || Object.keys(presets).length === 0 ? {} : { presets }),
    ...(workspaces === undefined || Object.keys(workspaces).length === 0 ? {} : { workspaces }),
    ...(sessions === undefined || Object.keys(sessions).length === 0 ? {} : { sessions }),
  }
}

/* ----------------------------- DTO parsing ----------------------------- */

const CANDIDATE_KEYS = [
  'id', 'name', 'description', 'whenToUse', 'source', 'provider', 'rootId', 'layout',
  'editable', 'deletable', 'invocation', 'version', 'diagnostics',
]

/** Parse one candidate view. */
export function parseCandidateView(value: unknown): SkillCandidateView {
  const v = parseKnown(value, 'candidate', CANDIDATE_KEYS)
  const inv = parseKnown(v.invocation, 'candidate.invocation', ['modelInvocable', 'userInvocable'])
  const source = parseString(v.source, 'candidate.source')
  if (source !== 'user-dsh' && source !== 'user-agents' && source !== 'workspace-dsh' && source !== 'workspace-agents') {
    fail('candidate.source is not a managed root kind')
  }
  const layout = parseString(v.layout, 'candidate.layout')
  if (layout !== 'bundle' && layout !== 'flat') fail('candidate.layout must be bundle or flat')
  return {
    id: parseString(v.id, 'candidate.id'),
    name: parseString(v.name, 'candidate.name'),
    description: parseString(v.description, 'candidate.description'),
    ...(v.whenToUse === undefined ? {} : { whenToUse: parseString(v.whenToUse, 'candidate.whenToUse') }),
    source,
    provider: parseString(v.provider, 'candidate.provider'),
    rootId: parseString(v.rootId, 'candidate.rootId'),
    layout,
    editable: parseBoolean(v.editable, 'candidate.editable'),
    deletable: parseBoolean(v.deletable, 'candidate.deletable'),
    invocation: {
      modelInvocable: parseBoolean(inv.modelInvocable, 'candidate.invocation.modelInvocable'),
      userInvocable: parseBoolean(inv.userInvocable, 'candidate.invocation.userInvocable'),
    },
    ...(v.version === undefined ? {} : { version: parseString(v.version, 'candidate.version') }),
    diagnostics: parseDiagnostics(v.diagnostics),
  }
}

/** Parse one diagnostic array. */
export function parseDiagnostics(value: unknown): readonly SkillDiagnosticView[] {
  const entries = parseArray(value, 'diagnostics')
  return entries.map((entry, index) => {
    const v = parseKnown(entry, `diagnostics[${index}]`, ['code', 'message'])
    return {
      code: parseString(v.code, `diagnostics[${index}].code`),
      message: parseString(v.message, `diagnostics[${index}].message`),
    }
  })
}

/** Parse one policy explanation step. */
export function parseExplanationStep(value: unknown, index: number): PolicyExplanation['steps'][number] {
  const v = parseKnown(value, `explanation[${index}]`, [
    'scope', 'key', 'present', 'mode', 'state', 'effectiveMode', 'effectiveState',
  ])
  return {
    scope: parseString(v.scope, `explanation[${index}].scope`) as PolicyExplanation['steps'][number]['scope'],
    ...(v.key === undefined ? {} : { key: parseString(v.key, `explanation[${index}].key`) }),
    present: parseBoolean(v.present, `explanation[${index}].present`),
    mode: parseString(v.mode, `explanation[${index}].mode`) as PolicyExplanation['steps'][number]['mode'],
    state: parseString(v.state, `explanation[${index}].state`) as PolicyExplanation['steps'][number]['state'],
    effectiveMode: parseString(v.effectiveMode, `explanation[${index}].effectiveMode`) as PolicyExplanation['steps'][number]['effectiveMode'],
    effectiveState: v.effectiveState === undefined
      ? undefined
      : parseString(v.effectiveState, `explanation[${index}].effectiveState`) as PolicyExplanation['steps'][number]['effectiveState'],
  }
}

/** Parse one policy explanation. */
export function parseExplanation(value: unknown, label: string): PolicyExplanation {
  const v = parseKnown(value, label, [
    'allowed', 'reason', 'authorAllowed', 'mode', 'state', 'steps',
  ])
  return {
    allowed: parseBoolean(v.allowed, `${label}.allowed`),
    reason: parseString(v.reason, `${label}.reason`) as PolicyExplanation['reason'],
    authorAllowed: parseBoolean(v.authorAllowed, `${label}.authorAllowed`),
    mode: parseString(v.mode, `${label}.mode`) as PolicyExplanation['mode'],
    state: v.state === undefined
      ? undefined
      : parseString(v.state, `${label}.state`) as PolicyExplanation['state'],
    steps: parseArray(v.steps, `${label}.steps`).map((step, index) => parseExplanationStep(step, index)),
  }
}

const EFFECTIVE_KEYS = [
  'name', 'description', 'whenToUse', 'source', 'provider', 'author',
  'effective', 'shadowedBy', 'model', 'user', 'effectiveInvocation',
]

/** Parse one effective skill row. */
export function parseEffectiveSkill(value: unknown): EffectiveSkillView {
  const v = parseKnown(value, 'effective skill', EFFECTIVE_KEYS)
  const author = parseKnown(v.author, 'effective skill.author', ['modelInvocable', 'userInvocable'])
  let effectiveInvocation: AuthorInvocationPolicy | undefined
  if (v.effectiveInvocation !== undefined) {
    const flags = parseKnown(v.effectiveInvocation, 'effective skill.effectiveInvocation', ['modelInvocable', 'userInvocable'])
    effectiveInvocation = {
      modelInvocable: parseBoolean(flags.modelInvocable, 'effective skill.effectiveInvocation.modelInvocable'),
      userInvocable: parseBoolean(flags.userInvocable, 'effective skill.effectiveInvocation.userInvocable'),
    }
  }
  return {
    name: parseString(v.name, 'effective skill.name'),
    description: parseString(v.description, 'effective skill.description'),
    ...(v.whenToUse === undefined ? {} : { whenToUse: parseString(v.whenToUse, 'effective skill.whenToUse') }),
    source: parseString(v.source, 'effective skill.source'),
    provider: parseString(v.provider, 'effective skill.provider'),
    author: {
      modelInvocable: parseBoolean(author.modelInvocable, 'effective skill.author.modelInvocable'),
      userInvocable: parseBoolean(author.userInvocable, 'effective skill.author.userInvocable'),
    },
    effective: parseBoolean(v.effective, 'effective skill.effective'),
    ...(v.shadowedBy === undefined ? {} : { shadowedBy: parseString(v.shadowedBy, 'effective skill.shadowedBy') }),
    model: parseExplanation(v.model, 'effective skill.model'),
    user: parseExplanation(v.user, 'effective skill.user'),
    ...(effectiveInvocation === undefined ? {} : { effectiveInvocation }),
  }
}

const TRASH_KEYS = ['id', 'name', 'rootId', 'layout', 'deletedAt']

/** Parse a trash view. */
export function parseTrashView(value: unknown): TrashView {
  const v = parseKnown(value, 'trash entry', TRASH_KEYS)
  const layout = parseString(v.layout, 'trash entry.layout')
  if (layout !== 'bundle' && layout !== 'flat') fail('trash entry.layout must be bundle or flat')
  return {
    id: parseString(v.id, 'trash entry.id'),
    name: parseString(v.name, 'trash entry.name'),
    rootId: parseString(v.rootId, 'trash entry.rootId'),
    layout,
    deletedAt: parseString(v.deletedAt, 'trash entry.deletedAt'),
  }
}

/** Parse a scope option. */
export function parseScopeOption(value: unknown): PolicyScopeOption {
  const v = parseKnown(value, 'scope option', ['scope', 'id', 'label'])
  const scope = parseString(v.scope, 'scope option.scope')
  if (scope !== 'preset' && scope !== 'workspace' && scope !== 'session') fail('scope option.scope is invalid')
  return {
    scope,
    id: parseString(v.id, 'scope option.id'),
    ...(v.label === undefined ? {} : { label: parseString(v.label, 'scope option.label') }),
  }
}

/** Parse a policy context object. */
export function parsePolicyContext(value: unknown): PolicyContext {
  const v = parseKnown(value, 'policy context', ['preset', 'workspace', 'session'])
  return {
    ...(v.preset === undefined ? {} : { preset: parseString(v.preset, 'policy context.preset') }),
    ...(v.workspace === undefined ? {} : { workspace: parseString(v.workspace, 'policy context.workspace') }),
    ...(v.session === undefined ? {} : { session: parseString(v.session, 'policy context.session') }),
  }
}

/** Parse an import request. */
export function parseImportRequest(value: unknown): SkillImportRequest {
  const v = parseKnown(value, 'import request', ['paths', 'rootId'])
  const paths = parseArray(v.paths, 'import request.paths').map((entry, index) =>
    parseString(entry, `import request.paths[${index}]`))
  if (paths.length === 0) fail('import request.paths must not be empty')
  return { paths, rootId: parseString(v.rootId, 'import request.rootId') }
}

/** Parse an import result. */
export function parseImportResult(value: unknown): SkillImportResult {
  const v = parseKnown(value, 'import result', ['items', 'imported'])
  const items = parseArray(v.items, 'import result.items').map((entry, index) => {
    const item = parseKnown(entry, `import result.items[${index}]`, ['index', 'name', 'status', 'diagnostics'])
    const rawStatus = parseString(item.status, `import result.items[${index}].status`)
    if (rawStatus !== 'imported' && rawStatus !== 'conflict' && rawStatus !== 'invalid' && rawStatus !== 'error') {
      fail(`import result.items[${index}].status is invalid`)
    }
    const status = rawStatus as SkillImportItemView['status']
    return {
      index: parseNumber(item.index, `import result.items[${index}].index`),
      ...(item.name === undefined ? {} : { name: parseString(item.name, `import result.items[${index}].name`) }),
      status,
      ...(item.diagnostics === undefined ? {} : { diagnostics: parseDiagnostics(item.diagnostics) }),
    }
  })
  return {
    items,
    imported: parseNumber(v.imported, 'import result.imported'),
  }
}

/** Parse a snapshot request. */
export function parseSnapshotRequest(value: unknown): SnapshotRequest {
  const v = parseKnown(value, 'snapshot request', ['scope', 'id'])
  let scope: SnapshotRequest['scope'] | undefined
  if (v.scope !== undefined) {
    const raw = parseString(v.scope, 'snapshot request.scope')
    if (raw !== 'preset' && raw !== 'workspace' && raw !== 'session') fail('snapshot request.scope is invalid')
    scope = raw
  }
  const id = v.id === undefined ? undefined : parseString(v.id, 'snapshot request.id')
  if ((scope === undefined) !== (id === undefined)) fail('snapshot request must supply scope and id together')
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(id === undefined ? {} : { id }),
  }
}

/** Parse a complete snapshot. */
export function parseSnapshot(value: unknown): SkillManagerSnapshot {
  const v = parseKnown(value, 'snapshot', [
    'roots', 'candidates', 'effective', 'trash', 'scopeOptions', 'document', 'context', 'revision',
  ])
  return {
    roots: parseArray(v.roots, 'snapshot.roots').map((entry, index) => {
      const root = parseKnown(entry, `snapshot.roots[${index}]`, ['id', 'kind', 'label', 'writable', 'available'])
      const kind = parseString(root.kind, `snapshot.roots[${index}].kind`)
      if (kind !== 'user-dsh' && kind !== 'user-agents' && kind !== 'workspace-dsh' && kind !== 'workspace-agents') {
        fail(`snapshot.roots[${index}].kind is not a managed root kind`)
      }
      return {
        id: parseString(root.id, `snapshot.roots[${index}].id`),
        kind,
        label: parseString(root.label, `snapshot.roots[${index}].label`),
        writable: parseBoolean(root.writable, `snapshot.roots[${index}].writable`),
        available: parseBoolean(root.available, `snapshot.roots[${index}].available`),
      }
    }),
    candidates: parseArray(v.candidates, 'snapshot.candidates').map(entry => parseCandidateView(entry)),
    effective: parseArray(v.effective, 'snapshot.effective').map(entry => parseEffectiveSkill(entry)),
    trash: parseArray(v.trash, 'snapshot.trash').map(entry => parseTrashView(entry)),
    scopeOptions: parseArray(v.scopeOptions, 'snapshot.scopeOptions').map(entry => parseScopeOption(entry)),
    document: v.document === null ? null : parsePolicyDocument(v.document),
    context: parsePolicyContext(v.context),
    revision: parseNumber(v.revision, 'snapshot.revision'),
  }
}

/* ------------------------- Codec and descriptor ------------------------ */

/** Strict codec contract understood by the Typert transport. */
export interface WireCodec<Output = unknown> {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly schema: {
    parse(value: unknown): Output
  }
}

/** One ordered Remote parameter. */
export interface WireParameter {
  readonly name: string
  readonly wire: string
  readonly source: 'json'
  readonly codec: WireCodec
}

/** One direct Remote invocation descriptor. */
export interface WireDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly WireParameter[]
  readonly result: WireCodec
}

/** Build a strict codec from a parse function. */
export function codec<Output>(typeSymbol: string, parse: (value: unknown) => Output): WireCodec<Output> {
  return Object.freeze({
    mode: 'strict',
    typeSymbol: `${PACKAGE}/${typeSymbol}`,
    schema: Object.freeze({ parse }),
  })
}

/** Build one direct Remote parameter. */
export function param(name: string, codecValue: WireCodec): WireParameter {
  return { name, wire: name, source: 'json', codec: codecValue }
}

/** Build one direct invocation descriptor. */
export function invocation(
  method: SkillManagerMethod,
  parameters: readonly WireParameter[],
  result: WireCodec,
): WireDescriptor {
  return {
    id: `${PACKAGE}#${SERVICE}/${method}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result,
  }
}

/** Client contribution passed to `ctx.remote.$mount`. */
export interface WireContribution {
  readonly package: string
  readonly descriptors: readonly WireDescriptor[]
}

/* ------------------------------ Envelope ------------------------------- */

/** Minimal client-side view of the transport envelope. */
export interface WireEnvelope<Value> {
  readonly ok: boolean
  readonly value?: Value
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly details?: { readonly code?: SkillManagerErrorCode }
  }
}

/**
 * Unwrap one Remote result envelope.
 * @param envelope - transport answer.
 * @returns the business value.
 * @throws Error carrying the stable code when the call failed.
 */
export function unwrap<Value>(envelope: WireEnvelope<Value>): Value {
  if (envelope.ok === true) return envelope.value as Value
  const error = envelope.error
  const message = error?.message ?? 'The DSH server rejected this request.'
  const code = error?.details?.code ?? error?.code
  const failure = new Error(message)
  ;(failure as { code?: string }).code = code ?? 'UNAVAILABLE'
  throw failure
}

/* ------------------------- unused re-exports guard --------------------- */

/** @internal Re-export used by host code to keep PolicyLayer typing local. */
export type { PolicyLayer }
