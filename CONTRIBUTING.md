# Contributing to dsh-skill-manager

Thanks for helping! This repository is an independent ecosystem plugin for
DeepSeek Harness. It is not part of the official Harness repository and does
not accept changes that patch installed Harness packages or shipped agent
presets.

## Ground rules

- **No runtime validation without approval in your environment.** This plugin
  manages agent skills and policy; exercising it against a live Harness can
  affect running sessions. When developing against a machine that may be
  running Harness workloads, ask the operator before starting any test, build,
  typecheck, lint, runtime activation, or browser verification.
- Keep the three planes clean: Host owns persistence, filesystem mutation,
  policy, and Remote DTOs; an Agent scope owns only overlay registrations;
  the Client owns the Settings page and never touches the filesystem.
- Every user-visible string in the Client lives in the typed `en`/`zh`
  dictionaries. No hard-coded product copy.
- Security invariants (containment, opaque ids, CAS, trash-first deletion,
  detached JSON wire values) are enforced in the operation that makes the
  decision and are covered by tests. See `docs/security.md`.

## Development

```powershell
npm install
npm run typecheck   # requires operator approval if a Harness is running
npm test
npm run build
```

Manual verification against a real profile:

```powershell
npm run build
dsh plugin --profile web add .
```

## Code layout

```text
src/
  types.ts        public policy types (version 1)
  policy.ts       pure policy normalization/validation/resolution
  authoring.ts    Host filesystem service (discovery, CRUD, trash, containment)
  wire.ts         shared detached DTOs, codecs, descriptors (browser-safe)
  remote.ts       Host controller + Typert gateway for remote.skillManager
  runtime.ts      policy store + per-Agent overlay engine
  index.ts        host plugin entry (settings namespace, typert, engine)
  client/         browser Settings section (locale-owned copy)
tests/            unit specs (vitest)
```

## Pull requests

- One logical change per PR; update the corresponding tests and docs in the
  same change.
- Describe the operator-visible behavior change in the description.
- Keep `docs/architecture.md` and `docs/security.md` in sync when contracts
  change.
- Do not add a dependency without stating why the existing surface cannot do
  the job and that the package family matches the supported Harness version.

## Releases

Versions follow SemVer. Release artifacts are produced by `npm run build`
(`lib/index.js`, `lib/client.js`, `lib/types/**`) plus `cordis.patch.yml`;
the npm package is installed through `dsh plugin --profile web add`.
