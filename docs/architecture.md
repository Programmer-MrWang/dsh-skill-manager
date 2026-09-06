# Architecture

## Planes

The manager follows Harness ownership boundaries:

- **Host plane** owns persistence, filesystem mutation, trust classification, policy resolution, session/workspace observation, Remote methods, and the global skill registry adapter.
- **Agent scope** owns only per-Agent overlay registrations and listeners. Their Fiber teardown removes every overlay.
- **Client plane** owns the `settings.section` page and browser state. It receives path-free JSON DTOs and never touches the filesystem.

## Domain model

### Skill root

A root is a Host-owned capability, not a browser path.

```ts
type SkillRootKind = 'user-dsh' | 'user-agents' | 'workspace-dsh' | 'workspace-agents'

interface SkillRootView {
  id: string
  kind: SkillRootKind
  label: string
  writable: boolean
  available: boolean
}
```

The Client sends `rootId` and `candidateId`; only the Host resolves absolute paths.

### Installed candidate

```ts
interface SkillCandidateView {
  id: string
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  rootId?: string
  layout: 'bundle' | 'flat' | 'runtime' | 'remote'
  editable: boolean
  deletable: boolean
  effective: boolean
  shadowedBy?: string
  invocation: {
    modelInvocable: boolean
    userInvocable: boolean
  }
  version?: string
  diagnostics: readonly SkillDiagnosticView[]
}
```

Candidate IDs are opaque and do not reveal absolute paths.

### Policy

A policy document is versioned and data-only:

```ts
type SkillPolicyMode = 'inherit' | 'all' | 'allow-list' | 'deny-list'
type SkillPolicyDecision = 'inherit' | 'allow' | 'deny'

interface SkillPolicyDocumentV1 {
  version: 1
  mode: SkillPolicyMode
  overrides: Record<string, SkillPolicyDecision>
}
```

Scopes are ordered from least to most specific:

```text
global < preset < workspace < session
```

The most specific non-`inherit` decision wins. Original Skill invocation controls are hard gates: policy can further restrict a Skill but cannot re-enable an audience disabled by its author.

## Host modules

### `SkillAuthoringService`

Owns writable roots and mutations:

- `listRoots()`
- `listCandidates(context)`
- `readCandidate(candidateId)`
- `validateDraft(draft)`
- `create(rootId, draft)`
- `update(candidateId, expectedVersion, draft)`
- `copy(candidateId, rootId, newName)`
- `trash(candidateId, expectedVersion)`
- `restore(trashId)`
- `deletePermanently(trashId)`

Writes are atomic and guarded by an opaque version. Deletes move content to a manager-owned trash directory first.

### `SkillPolicyService`

Owns policy persistence and resolution:

- global and workspace policy use the Harness settings/storage plane;
- preset policy is keyed by immutable preset ID without editing its composition;
- session policy is append-only session state where the installed Harness API supports it, with a versioned external store fallback for `0.1.2-alpha.5`;
- `resolve(context)` returns a detached immutable policy snapshot;
- `explain(skill, context)` returns the decisive scope and reason.

### `SkillRuntimeAdapter`

For Harness `0.1.2-alpha.5` the adapter keeps every live Agent's effective
view equal to its layered policy without a core filter seam:

1. Preset rows register skill providers in the Agent's own scope; the adapter
   disposes its previous overlay, then reads the neutral winners in that same
   scope.
2. `computeOverlayRestrictions` keeps exactly the skills whose effective
   invocation differs from the author's — policy can only tighten.
3. Register one Agent-scope provider (`skill-manager-policy`, rank 1) whose
   candidates shadow those names; the scope layer wins duplicates, so a denied
   high-priority candidate can never reveal a lower-priority skill with the
   same name.
4. Bodies are captured at recompute time (the underlying winners live in the
   same scope, so a live delegation would recurse) and served from the
   provider's stored definitions.
5. Rebuild the provider whenever policy, catalog, preset, or session state
   changes (`agent/created`, `agent/disposed`, `skills/change`, policy watch).

A future adapter may call audience-aware core APIs when available.

### `SkillManagerController`

Exposes strict Remote DTOs under `skillManager/*`. It returns stable error codes for invalid input, not found, read-only, conflict, containment refusal, and unavailable capabilities. No live Cordis object or absolute Host path crosses the wire.

## Client modules

The Client registers one additive settings section:

```text
settings.section / id=skills
```

The page has four views:

1. **Installed** — effective and shadowed candidates, trust, source, diagnostics.
2. **Policies** — global/preset/workspace/session inheritance and effective preview.
3. **Editor** — structured frontmatter plus Markdown body and diff/conflict flow.
4. **Import & trash** — paste/file/directory import, recoverable deletion.

State follows a controller + immutable snapshot store pattern. Mutations are pessimistic: authority is reloaded from the Host after success, while drafts survive errors.

## Consistency invariant

For a given Agent step, all entry points must observe one effective policy snapshot:

```text
model <available_skills>
skill(name) tool
explicit /name injection
Web slash candidates
```

The compatibility overlay achieves this through the existing registry winner and invocation booleans. A core adapter must use one audience-aware visibility API if supported.

## Lifecycle

Every provider, overlay, event listener, Remote binding, locale dictionary, Slot registration, watcher, and timer is owned by a Cordis Fiber and has an exact disposer. Updating or removing the plugin leaves no policy overlay or browser occupant behind.
