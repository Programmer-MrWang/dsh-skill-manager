# Manual verification guide for live-session enforcement

Automated checks cover installation, the Settings UI, disk-skill authoring,
policy persistence, and the registry-level overlay semantics (see
`tests/registry.spec.ts` and the README status note). The final step —
observing enforcement inside one live model session — needs a real profile
with an API key and normally mounted agent presets, so it is a manual run.

## Prerequisites

- A DeepSeek Harness web profile with a working API key and at least one
  existing session (so preset rows such as `skill-filesystem` and `tool-skill`
  are mounted normally).
- The built package: `npm pack` in this repository produces
  `dsh-skill-manager-0.1.0.tgz`.

## Steps

1. Install and restart the profile:

   ```powershell
   # from the harness deployment root
   dsh plugin --profile web add .\path\to\dsh-skill-manager-0.1.0.tgz
   dsh web          # restart the profile (plan this when no task is running)
   ```

2. Seed one user skill if none exists (create `$DSH_HOME/skills/alpha/SKILL.md`):

   ```markdown
   ---
   name: alpha
   description: Does alpha things.
   ---
   # Alpha
   Follow these instructions when asked about alpha.
   ```

3. Open Settings → Skills → Installed:

   - The managed list shows `alpha` (Bundle, version badge, Effective status).
   - The effective catalog lists `alpha` as model/user allowed when no policy
     exists.

4. Open Settings → Skills → Policies, choose Global, set mode to
   **Allow list**, leave the skill list empty, and save. Reopen Installed:

   - `alpha` now shows the restricted/disabled badge; the catalog row reports
     model and user as denied, and the managed file shows "Restricted by
     policy" instead of "Effective".

5. Start a new session (any preset) and send this message:

   > List every skill in your available skills catalog. Then call the skill
   > tool once with the name `alpha` and report its full result.

   Expected under the allow-list policy:

   - `alpha` does not appear in the model's catalog;
   - the `skill` tool refuses `alpha` (unknown or not invocable) instead of
     returning its body;
   - the reply never contains the marker text "Follow these instructions when
     asked about alpha".

6. Send a message whose text contains a standalone `/alpha` token:

   Expected: no skill body is injected into the conversation (the user
   invocation is also denied by the same booleans).

7. Restore: in Policies set Global mode back to **Deny list** (or reset the
   layer) and repeat step 5 — `alpha` must be visible and loadable again.

## Cleanup

Remove the plugin when done:

```powershell
dsh plugin --profile web remove dsh-skill-manager
```

Remove the seeded skill by deleting `$DSH_HOME/skills/alpha` (or use the
manager's Trash view).
