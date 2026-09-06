/**
 * Public data types for the version 1 skill invocation policy document.
 *
 * @module dsh-skill-manager/types
 */

/** The policy document format implemented by this module. */
export type PolicyVersion = 1

/** A policy layer, ordered from least to most specific. */
export type PolicyScope = 'global' | 'preset' | 'workspace' | 'session'

/** The actor requesting a skill invocation. */
export type InvocationAuthor = 'model' | 'user'

/** A per-skill override at one policy layer. */
export type PolicyState = 'inherit' | 'allow' | 'deny'

/** The default selection behavior established by one policy layer. */
export type PolicyMode = 'inherit' | 'all' | 'allow-list' | 'deny-list'

/**
 * Invocation metadata authored by the skill provider.
 *
 * These flags are a hard gate: layered policy cannot enable an invocation that
 * its author disabled. The fields correspond to DSH 0.1.2-alpha.5
 * `SkillInvocationPolicy`.
 */
export interface AuthorInvocationPolicy {
  /** Whether the skill author permits model invocation. */
  readonly modelInvocable: boolean
  /** Whether the skill author permits explicit user invocation. */
  readonly userInvocable: boolean
}

/** Policy contributed by one scope. */
export interface PolicyLayer {
  /**
   * Default behavior for skills without an effective per-skill override.
   * `inherit` retains the nearest less-specific mode.
   */
  readonly mode?: PolicyMode
  /** Per-skill states keyed by the DSH kebab-case skill name. */
  readonly skills?: Readonly<Record<string, PolicyState>>
}

/** Version 1 persisted policy document. */
export interface PolicyDocumentV1 {
  /** Format discriminator. */
  readonly version: 1
  /** Least-specific policy layer. */
  readonly global?: PolicyLayer
  /** Preset layers keyed by preset identifier. */
  readonly presets?: Readonly<Record<string, PolicyLayer>>
  /** Workspace layers keyed by the caller's canonical workspace identifier. */
  readonly workspaces?: Readonly<Record<string, PolicyLayer>>
  /** Most-specific layers keyed by DSH session identifier. */
  readonly sessions?: Readonly<Record<string, PolicyLayer>>
}

/** Canonical policy layer with explicit defaults and sorted skill keys. */
export interface NormalizedPolicyLayer {
  /** Explicit layer mode. */
  readonly mode: PolicyMode
  /** Explicit per-skill states, including meaningful `inherit` entries. */
  readonly skills: Readonly<Record<string, PolicyState>>
}

/** Canonical version 1 document returned by normalization. */
export interface NormalizedPolicyDocumentV1 {
  /** Format discriminator. */
  readonly version: 1
  /** Explicit global layer. */
  readonly global: NormalizedPolicyLayer
  /** Preset layers in lexicographic key order. */
  readonly presets: Readonly<Record<string, NormalizedPolicyLayer>>
  /** Workspace layers in lexicographic key order. */
  readonly workspaces: Readonly<Record<string, NormalizedPolicyLayer>>
  /** Session layers in lexicographic key order. */
  readonly sessions: Readonly<Record<string, NormalizedPolicyLayer>>
}

/** Scope selectors for one policy lookup. */
export interface PolicyContext {
  /** Active preset identifier, when a preset layer applies. */
  readonly preset?: string
  /** Active canonical workspace identifier, when a workspace layer applies. */
  readonly workspace?: string
  /** Active DSH session identifier, when a session layer applies. */
  readonly session?: string
}

/** Input required to decide one invocation. */
export interface PolicyResolutionRequest extends PolicyContext {
  /** Kebab-case skill name. */
  readonly skill: string
  /** Actor attempting the invocation. */
  readonly invocation: InvocationAuthor
  /** Invocation permissions declared by the skill author. */
  readonly author: AuthorInvocationPolicy
}

/** Stable validation diagnostic. */
export interface PolicyValidationIssue {
  /** JSON Pointer locating the invalid value. */
  readonly path: string
  /** Machine-readable diagnostic category. */
  readonly code: 'type' | 'required' | 'unknown-key' | 'value' | 'skill-name' | 'empty-key'
  /** Human-readable explanation of the invalid value. */
  readonly message: string
}

/** Result of validating an unknown policy document. */
export type PolicyValidationResult =
  | { readonly valid: true; readonly value: PolicyDocumentV1; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly PolicyValidationIssue[] }

/** One layer consulted while resolving a policy. */
export interface PolicyExplanationStep {
  /** Scope represented by this step. */
  readonly scope: PolicyScope
  /** Selected identifier; absent for the global scope. */
  readonly key?: string
  /** Whether the document contained the selected layer. */
  readonly present: boolean
  /** Mode declared by the layer, or `inherit` when absent. */
  readonly mode: PolicyMode
  /** State declared for the requested skill, or `inherit` when absent. */
  readonly state: PolicyState
  /** Effective mode after applying this layer. */
  readonly effectiveMode: Exclude<PolicyMode, 'inherit'>
  /** Effective per-skill override after applying this layer. */
  readonly effectiveState: Exclude<PolicyState, 'inherit'> | undefined
}

/** Complete, deterministic explanation for one invocation decision. */
export interface PolicyExplanation {
  /** Whether invocation is permitted after the author gate and layered policy. */
  readonly allowed: boolean
  /** Stable summary of the decisive rule. */
  readonly reason: 'author-deny' | 'skill-allow' | 'skill-deny' | 'mode-all' | 'mode-allow-list' | 'mode-deny-list'
  /** Whether the skill author's invocation metadata permitted this actor. */
  readonly authorAllowed: boolean
  /** Effective layered mode. */
  readonly mode: Exclude<PolicyMode, 'inherit'>
  /** Effective per-skill override, when one exists. */
  readonly state: Exclude<PolicyState, 'inherit'> | undefined
  /** Consulted layers in `global`, `preset`, `workspace`, `session` order. */
  readonly steps: readonly PolicyExplanationStep[]
}
