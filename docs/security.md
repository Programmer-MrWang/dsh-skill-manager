# Security model

Skill content is executable social control over an Agent. Managing Skills is therefore a security-sensitive authoring capability, even though a Skill is stored as Markdown.

## Trust classes

- **shipped/bundled**: readable and copyable, never editable or deletable;
- **runtime/remote**: readable when the provider permits, otherwise summary-only; never assumed writable;
- **user roots**: writable subject to Host policy;
- **workspace roots**: writable only when the active sandbox and approval policy permit it.

The UI displays source and trust on every candidate and never equates “installed” with “trusted”.

## Filesystem rules

1. The Client never submits an arbitrary absolute path.
2. The Host maps opaque root and candidate IDs to canonical targets.
3. Every read and mutation re-checks canonical containment.
4. Symlink and junction escapes are rejected.
5. Skill names use `^[a-z0-9]+(?:-[a-z0-9]+)*$` and cannot become path segments outside their root.
6. Import rejects absolute archive paths, `..`, device files, links, excessive depth, excessive file count, and excessive total size.
7. Writes are atomic and revision-guarded.
8. Delete means move to manager-owned trash; permanent removal is a separate confirmed action.
9. Shipped preset and package-install directories are immutable from this plugin.

## Wire rules

Remote responses contain detached JSON only. They never contain:

- Cordis Context, Service, Provider, Agent, Session, or Scope objects;
- opaque provider locators;
- canonical absolute Host paths;
- unrestricted directory listings;
- unredacted settings secrets.

Stable error codes are used instead of stack traces.

## Policy rules

- The author's `modelInvocable: false` and `userInvocable: false` decisions are hard gates.
- Administrative policy may restrict but cannot loosen those gates.
- Filtering happens after winner selection, preventing a denied high-priority candidate from exposing a lower-priority duplicate.
- Model catalog, loader tool, `/name`, and browser menu must agree.
- Changing policy affects future steps; previously retained Skill instructions remain historical context and are not retroactively erased.

## Supply chain

Git installation is intentionally deferred until the local authoring path is complete. When added, it must record origin URL and immutable revision, preview changes, refuse post-install execution, and recommend pinning a commit.
