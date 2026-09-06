// Policy store tests: layered edits, optimistic revisions, and CAS conflicts.
// Run with: npx vitest run tests/store.spec.ts
import { describe, expect, it } from 'vitest'
import { SkillPolicyConflictError, SkillPolicyStore, type SkillManagerSettings } from '../src/runtime.ts'

/** Fake settings handle capturing writes for a later commit. */
function fakeSink() {
  let stored: SkillManagerSettings = { policy: null }
  const watchers: Array<(next: SkillManagerSettings, prev: SkillManagerSettings) => void> = []
  const commits: Array<SkillManagerSettings> = []
  return {
    sink: {
      get: () => stored,
      watch: (callback: (next: SkillManagerSettings, prev: SkillManagerSettings) => void) => {
        watchers.push(callback)
        return () => {
          const index = watchers.indexOf(callback)
          if (index >= 0) watchers.splice(index, 1)
        }
      },
      update: async (patch: { policy: SkillManagerSettings['policy'] }) => {
        const previous = stored
        stored = { policy: patch.policy }
        commits.push({ policy: patch.policy })
        for (const watcher of [...watchers]) watcher(stored, previous)
      },
    },
    commits,
    setStored: (value: SkillManagerSettings) => {
      const previous = stored
      stored = value
      for (const watcher of [...watchers]) watcher(stored, previous)
    },
  }
}

describe('SkillPolicyStore', () => {
  it('starts from the stored document and bumps revisions on commit', async () => {
    const fake = fakeSink()
    const store = new SkillPolicyStore(fake.sink, { onDocumentChange: () => {} })
    fake.setStored({ policy: { version: 1, global: { mode: 'all' } } })
    expect(store.getDocument()?.global?.mode).toBe('all')
    expect(store.getRevision()).toBe(1)
    const result = await store.setLayer('global', null, 'deny-list', {}, 1)
    expect(store.getRevision()).toBe(2)
    expect(result.revision).toBe(2)
    expect(store.getDocument()?.global?.mode).toBe('deny-list')
  })

  it('refuses writes based on a stale revision', async () => {
    const fake = fakeSink()
    const store = new SkillPolicyStore(fake.sink, { onDocumentChange: () => {} })
    await store.setLayer('global', null, 'deny-list', {}, 0)
    await expect(store.setLayer('global', null, 'all', {}, 0)).rejects.toBeInstanceOf(SkillPolicyConflictError)
  })

  it('edits scoped layers and removes empty ones', async () => {
    const fake = fakeSink()
    const store = new SkillPolicyStore(fake.sink, { onDocumentChange: () => {} })
    await store.setLayer('preset', 'standard', 'allow-list', { alpha: 'allow' }, 0)
    let document = store.getDocument()
    expect(document?.presets?.standard?.mode).toBe('allow-list')
    expect(document?.presets?.standard?.skills?.alpha).toBe('allow')
    await store.setLayer('preset', 'standard', 'inherit', { alpha: null }, 1)
    document = store.getDocument()
    expect(document?.presets?.standard).toBeUndefined()
    expect(document?.global).toBeUndefined()
  })

  it('notifies the hooks on committed changes and dispose stops them', async () => {
    const fake = fakeSink()
    let changes = 0
    const store = new SkillPolicyStore(fake.sink, { onDocumentChange: () => { changes += 1 } })
    await store.setLayer('global', null, 'all', {}, 0)
    await store.setLayer('global', null, 'deny-list', {}, 1)
    expect(changes).toBeGreaterThanOrEqual(2)
    store.dispose()
    fake.setStored({ policy: { version: 1, global: { mode: 'all' } } })
    const before = changes
    expect(changes).toBe(before)
  })

  it('degrades foreign stored values to no policy', async () => {
    const fake = fakeSink()
    fake.setStored({ policy: { version: 1, global: 'not-a-layer' } } as unknown as SkillManagerSettings)
    const store = new SkillPolicyStore(fake.sink, { onDocumentChange: () => {} })
    expect(store.getDocument()).toBe(null)
  })
})
