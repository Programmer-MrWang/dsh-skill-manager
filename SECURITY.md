# Security Policy for dsh-skill-manager

## Supported targets

The plugin targets DeepSeek Harness `0.1.2-alpha.5` (Web profile). Only the
latest release of this repository receives security fixes.

## Reporting a vulnerability

Do **not** open a public issue for a vulnerability. Report privately to the
repository maintainers via a GitHub private vulnerability report (Security →
Report a vulnerability), or by email to the addresses listed in the repository
metadata. You will receive an acknowledgment within 72 hours.

## Threat model

See [`docs/security.md`](docs/security.md) for the full model. The short form:

- The **browser page is untrusted input**: it sends only opaque root and
  candidate identifiers; the Host resolves every path and re-checks
  containment (realpath, no symlink/junction escapes, no traversal).
- **Filesystem mutations are confined** to four managed roots
  (`~/.dsh/skills`, `~/.agents/skills`, and each workspace's
  `.dsh/skills` / `.agents/skills`), are atomic (temp + rename), and are
  guarded by optimistic CAS versions.
- **Deletion is recoverable**: permanent removal requires a second explicit
  call and only affects manager-owned trash entries.
- **Wire data is detached JSON**: no Cordis object, live Agent, Session, or
  absolute path ever crosses the Remote boundary.
- **Policy is a restriction layer only**: authored invocation booleans are a
  hard gate; layered policy can further deny but never re-enable an audience
  an author disabled.
- **Consistency**: policy is enforced through the registry's own winner
  selection and invocation booleans, so the model catalog, the `skill` tool,
  `/name`, and the Web slash menu all observe the same effective view. The
  plugin never filters before winner selection and therefore never reveals a
  shadowed lower-priority skill under a denied name.

## Supply chain

- Dependencies are pinned to the DeepSeek Harness `0.1.2-alpha.5` package
  family. Review `package.json` before upgrading.
- The plugin never patches an installed Harness, a shipped agent preset, or
  vendored code; it installs as an independent Profile Bundle
  (`dsh plugin --profile web add dsh-skill-manager`).

## Security checklist for contributors

- Any change that alters path resolution, containment, trash handling, or
  Remote DTO fields must include tests covering the refusal paths
  (symlink escape, stale CAS, unknown root/candidate ids, oversized files).
- Never accept an absolute path from the Client; never serialize a Host path
  into a DTO.
- Never log skill frontmatter bodies or stored policy documents at debug
  level beyond what a user explicitly inspects.
