/**
 * Pure normalization, validation, resolution, and explanation functions for
 * version 1 skill invocation policy documents.
 *
 * @module dsh-skill-manager/policy
 */

import type {
  NormalizedPolicyDocumentV1,
  NormalizedPolicyLayer,
  PolicyDocumentV1,
  PolicyExplanation,
  PolicyExplanationStep,
  PolicyLayer,
  PolicyMode,
  PolicyResolutionRequest,
  PolicyScope,
  PolicyState,
  PolicyValidationIssue,
  PolicyValidationResult,
} from './types.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MODES: readonly PolicyMode[] = ['inherit', 'all', 'allow-list', 'deny-list']
const STATES: readonly PolicyState[] = ['inherit', 'allow', 'deny']
const DOCUMENT_KEYS = new Set(['version', 'global', 'presets', 'workspaces', 'sessions'])
const LAYER_KEYS = new Set(['mode', 'skills'])
const DEFAULT_MODE: Exclude<PolicyMode, 'inherit'> = 'all'

/**
 * Return a canonical copy of a valid version 1 policy document.
 *
 * Omitted layers become empty `inherit` layers. Collection keys and skill names
 * are inserted in lexicographic order to make serialization deterministic.
 *
 * @param document - Valid version 1 policy document.
 * @returns A detached canonical policy document.
 */
export function normalizePolicy(document: PolicyDocumentV1): NormalizedPolicyDocumentV1 {
  return {
    version: 1,
    global: normalizeLayer(document.global),
    presets: normalizeLayerMap(document.presets),
    workspaces: normalizeLayerMap(document.workspaces),
    sessions: normalizeLayerMap(document.sessions),
  }
}

/**
 * Validate an untrusted value as a version 1 policy document.
 *
 * Validation rejects unknown fields, invalid identifiers, arrays in place of
 * objects, and unsupported values. It reports every independently discoverable
 * issue without mutating the input.
 *
 * @param input - Candidate value from JSON, YAML, or another persistence source.
 * @returns A discriminated result containing the typed document or diagnostics.
 */
export function validatePolicy(input: unknown): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = []
  if (!isRecord(input)) {
    addIssue(issues, '', 'type', 'policy document must be an object')
    return { valid: false, issues }
  }

  rejectUnknownKeys(input, DOCUMENT_KEYS, '', issues)
  if (!Object.hasOwn(input, 'version')) {
    addIssue(issues, '/version', 'required', 'version is required')
  } else if (input.version !== 1) {
    addIssue(issues, '/version', 'value', 'version must be 1')
  }

  if (Object.hasOwn(input, 'global')) validateLayer(input.global, '/global', issues)
  validateLayerMap(input, 'presets', issues)
  validateLayerMap(input, 'workspaces', issues)
  validateLayerMap(input, 'sessions', issues)

  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, value: input as unknown as PolicyDocumentV1, issues: [] }
}

/**
 * Resolve whether one actor may invoke a skill.
 *
 * The author's invocation metadata is checked first and cannot be overridden.
 * Otherwise layers apply in `global < preset < workspace < session` order.
 * Non-`inherit` modes and skill states replace the corresponding inherited
 * value independently. An effective skill state takes precedence over mode;
 * without one, `all` and `deny-list` allow while `allow-list` denies.
 *
 * @param document - Valid version 1 policy document.
 * @param request - Skill, actor, author metadata, and active scope selectors.
 * @returns Whether the invocation is allowed.
 */
export function resolvePolicy(document: PolicyDocumentV1, request: PolicyResolutionRequest): boolean {
  return explainPolicy(document, request).allowed
}

/**
 * Explain one invocation decision with every consulted policy layer.
 *
 * @param document - Valid version 1 policy document.
 * @param request - Skill, actor, author metadata, and active scope selectors.
 * @returns The decision, stable reason, effective values, and ordered trace.
 */
export function explainPolicy(document: PolicyDocumentV1, request: PolicyResolutionRequest): PolicyExplanation {
  const selected: readonly SelectedLayer[] = [
    { scope: 'global', layer: document.global },
    { scope: 'preset', key: request.preset, layer: selectLayer(document.presets, request.preset) },
    { scope: 'workspace', key: request.workspace, layer: selectLayer(document.workspaces, request.workspace) },
    { scope: 'session', key: request.session, layer: selectLayer(document.sessions, request.session) },
  ]

  let mode: Exclude<PolicyMode, 'inherit'> = DEFAULT_MODE
  let state: Exclude<PolicyState, 'inherit'> | undefined
  const steps: PolicyExplanationStep[] = []

  for (const selection of selected) {
    const declaredMode = selection.layer?.mode ?? 'inherit'
    const declaredState = selection.layer?.skills?.[request.skill] ?? 'inherit'
    if (declaredMode !== 'inherit') mode = declaredMode
    if (declaredState !== 'inherit') state = declaredState
    steps.push({
      scope: selection.scope,
      ...(selection.key === undefined ? {} : { key: selection.key }),
      present: selection.layer !== undefined,
      mode: declaredMode,
      state: declaredState,
      effectiveMode: mode,
      effectiveState: state,
    })
  }

  const authorAllowed = request.invocation === 'model'
    ? request.author.modelInvocable
    : request.author.userInvocable

  if (!authorAllowed) {
    return { allowed: false, reason: 'author-deny', authorAllowed, mode, state, steps }
  }
  if (state === 'allow') {
    return { allowed: true, reason: 'skill-allow', authorAllowed, mode, state, steps }
  }
  if (state === 'deny') {
    return { allowed: false, reason: 'skill-deny', authorAllowed, mode, state, steps }
  }
  if (mode === 'allow-list') {
    return { allowed: false, reason: 'mode-allow-list', authorAllowed, mode, state, steps }
  }
  return {
    allowed: true,
    reason: mode === 'all' ? 'mode-all' : 'mode-deny-list',
    authorAllowed,
    mode,
    state,
    steps,
  }
}

interface SelectedLayer {
  readonly scope: PolicyScope
  readonly key?: string
  readonly layer?: PolicyLayer
}

function normalizeLayer(layer: PolicyLayer | undefined): NormalizedPolicyLayer {
  const skills: Record<string, PolicyState> = {}
  for (const name of Object.keys(layer?.skills ?? {}).sort()) {
    const state = layer?.skills?.[name]
    if (state !== undefined) skills[name] = state
  }
  return { mode: layer?.mode ?? 'inherit', skills }
}

function normalizeLayerMap(
  layers: Readonly<Record<string, PolicyLayer>> | undefined,
): Readonly<Record<string, NormalizedPolicyLayer>> {
  const normalized: Record<string, NormalizedPolicyLayer> = {}
  for (const key of Object.keys(layers ?? {}).sort()) {
    const layer = layers?.[key]
    if (layer !== undefined) normalized[key] = normalizeLayer(layer)
  }
  return normalized
}

function validateLayerMap(
  document: Readonly<Record<string, unknown>>,
  field: 'presets' | 'workspaces' | 'sessions',
  issues: PolicyValidationIssue[],
): void {
  if (!Object.hasOwn(document, field)) return
  const value = document[field]
  const path = `/${field}`
  if (!isRecord(value)) {
    addIssue(issues, path, 'type', `${field} must be an object`)
    return
  }
  for (const key of Object.keys(value).sort()) {
    const itemPath = `${path}/${escapePointer(key)}`
    if (key.length === 0) addIssue(issues, itemPath, 'empty-key', `${field} keys must not be empty`)
    validateLayer(value[key], itemPath, issues)
  }
}

function validateLayer(value: unknown, path: string, issues: PolicyValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, 'type', 'policy layer must be an object')
    return
  }
  rejectUnknownKeys(value, LAYER_KEYS, path, issues)
  if (Object.hasOwn(value, 'mode') && !isOneOf(value.mode, MODES)) {
    addIssue(issues, `${path}/mode`, 'value', 'mode must be inherit, all, allow-list, or deny-list')
  }
  if (!Object.hasOwn(value, 'skills')) return
  if (!isRecord(value.skills)) {
    addIssue(issues, `${path}/skills`, 'type', 'skills must be an object')
    return
  }
  for (const name of Object.keys(value.skills).sort()) {
    const skillPath = `${path}/skills/${escapePointer(name)}`
    if (!SKILL_NAME.test(name)) {
      addIssue(issues, skillPath, 'skill-name', 'skill name must be lowercase kebab-case')
    }
    if (!isOneOf(value.skills[name], STATES)) {
      addIssue(issues, skillPath, 'value', 'skill state must be inherit, allow, or deny')
    }
  }
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: PolicyValidationIssue[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) {
      addIssue(issues, `${path}/${escapePointer(key)}`, 'unknown-key', `unknown field ${JSON.stringify(key)}`)
    }
  }
}

function selectLayer(
  layers: Readonly<Record<string, PolicyLayer>> | undefined,
  key: string | undefined,
): PolicyLayer | undefined {
  return key === undefined ? undefined : layers?.[key]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function addIssue(
  issues: PolicyValidationIssue[],
  path: string,
  code: PolicyValidationIssue['code'],
  message: string,
): void {
  issues.push({ path, code, message })
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
