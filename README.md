# DSH Skill Manager

English | [简体中文](README.zh-CN.md)

A publishable DeepSeek Harness plugin for discovering, authoring, installing, and governing AI agent skills from the Web settings page.

> Status: implementation complete for DeepSeek Harness `0.1.2-alpha.5` (Host
> policy store + authoring service, Remote `skillManager` namespace, scoped
> runtime overlays, browser Settings section, package metadata). Typecheck,
> unit tests (41 passing, incl. real-SkillRegistry overlay shadowing),
> artifact builds, runtime activation on an isolated smoke profile, headless
> browser verification (Settings → Skills views, disk-skill listing, policy
> write persisted to `settings.yaml`), and registry-level enforcement
> semantics have all passed. Live-session end-to-end enforcement is a known
> limitation with a step-by-step manual guide:
> [`docs/verification.md`](docs/verification.md).

## Goals

- Browse the effective skill catalog and every manageable filesystem candidate.
- Create, import, inspect, edit, copy, and remove user or workspace skills.
- Keep bundled, runtime, and shipped-preset skills read-only.
- Explain duplicate-name precedence instead of hiding shadowed candidates.
- Apply global, preset, workspace, and session policy with deterministic inheritance.
- Enforce the same effective policy for the model catalog, the `skill` tool, explicit `/name` invocation, and the Web slash menu.
- Preserve filesystem containment, optimistic concurrency, and reversible deletion.
- Ship as an ecosystem plugin; never patch an installed Harness or a shipped agent preset.

## Planned package

This repository ships one installable Profile Bundle with a dual Host/Client Cordis plugin:

```text
dsh-skill-manager
├── Host management and policy service
├── strict browser Remote API
├── scoped runtime policy overlays
└── Client settings.section UI
```

The implementation is kept internally modular so the Host capability, wire DTOs, policy engine, and Client UI can be split into separate packages later without changing persisted data.

## Compatibility strategy

DeepSeek Harness `0.1.2-alpha.5` exposes an invocation-neutral, layered `ctx.skills` registry but no mutation or policy-filter extension point. This plugin therefore keeps every live Agent's view equal to policy through a scoped overlay provider:

1. Resolve the registry's neutral winners below the Agent scope.
2. Register one Agent-scope provider (`skill-manager-policy`) whose low-rank candidates shadow only the skills policy tightens; bodies load live from the underlying registry.
3. Let the existing winner-selection and invocation checks apply that result consistently.
4. Rebuild the provider whenever policy, workspace, preset, or skill discovery changes.

The plugin never filters before winner selection, so disabling a high-priority candidate cannot reveal a lower-priority skill with the same name.

For future Harness versions, an adapter can use audience-aware core methods such as `getVisible`/`snapshotVisible` when they become available. Persisted policy and the browser API remain independent of that adapter.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/security.md`](docs/security.md).

## Installation

Installation instructions will be finalized after the first package build has been verified. The intended workflow is the supported profile plugin command:

```powershell
dsh plugin --profile web add dsh-skill-manager
```

The package contributes its own bundle patch and does not edit the shipped `web` profile or agent presets.

## Development safety

Builds, tests, type checks, linting, runtime activation, and browser verification are intentionally not run without the operator's explicit confirmation, because the development machine may already be running Harness workloads.

## License

MIT
