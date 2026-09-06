// @vitest-environment jsdom
// UI smoke for the folder-import flow: mounts the real section, clicks
// "Import folders", picks a folder through a stubbed picker, and imports.
// The section's own error boundary turns hidden render failures into visible
// text, so a regression here fails with the real message.
// Run with: npx vitest run tests/import-ui.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { en } from '../src/client/locales.ts'
import { SkillManagerSection } from '../src/client/index.ts'
import type { SkillManagerSnapshot } from '../src/wire.ts'

const fixture = (): SkillManagerSnapshot => ({
  roots: [{ id: 'root-user', kind: 'user-dsh', label: 'User (DSH)', writable: true, available: true }],
  candidates: [],
  effective: [],
  trash: [],
  scopeOptions: [],
  document: null,
  context: {},
  revision: 0,
})

const makeApi = (overrides: Record<string, unknown> = {}) => ({
  snapshot: async () => fixture(),
  readDraft: async () => { throw new Error('unexpected readDraft') },
  validateDraft: async () => { throw new Error('unexpected validateDraft') },
  create: async () => { throw new Error('unexpected create') },
  update: async () => { throw new Error('unexpected update') },
  copy: async () => { throw new Error('unexpected copy') },
  trash: async () => { throw new Error('unexpected trash') },
  restore: async () => { throw new Error('unexpected restore') },
  deletePermanently: async () => { throw new Error('unexpected deletePermanently') },
  setLayer: async () => { throw new Error('unexpected setLayer') },
  importFolders: async () => ({
    items: [{ index: 0, name: 'alpha', status: 'imported' as const }],
    imported: 1,
  }),
  ...overrides,
})

let container: HTMLDivElement
let root: Root

const flush = async (ms = 30): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const clickByText = (text: string): boolean => {
  const candidates = [...container.querySelectorAll('button')]
  const button = candidates.find(node => node.textContent?.includes(text))
  if (button === undefined) return false
  button.click()
  return true
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

describe('folder import flow', () => {
  const renderSection = (overrides: { pickFolder?: () => Promise<string | null>; api?: ReturnType<typeof makeApi> } = {}): void => {
    root = createRoot(container)
    root.render(createElement(SkillManagerSection, {
      api: overrides.api ?? makeApi(),
      pickFolder: overrides.pickFolder ?? (async () => null),
      t: key => en[key as keyof typeof en] ?? key,
    }))
  }

  it('stays visible after picking a folder and renders the staged row', async () => {
    renderSection({ pickFolder: async () => 'E:\\桌面\\skills\\skill-alpha' })
    await flush(60)

    expect(clickByText(en.importFolders)).toBe(true)
    await flush(30)
    expect(clickByText(en.importPick)).toBe(true)
    await flush(60)

    const text = container.textContent ?? ''
    // The staged folder (basename) must appear and the page must not be blank.
    expect(text).toContain('skill-alpha')
    expect(text).toContain(en.importConfirm)
    expect(container.querySelectorAll('.sm-panel').length).toBeGreaterThan(0)
    expect(text).not.toContain(en.renderError)
  })

  it('renders import outcomes without going blank', async () => {
    renderSection({ pickFolder: async () => 'C:\\skills\\beta' })
    await flush(60)

    clickByText(en.importFolders)
    await flush(30)
    clickByText(en.importPick)
    await flush(60)
    clickByText(en.importConfirm)
    await flush(120)

    const text = container.textContent ?? ''
    expect(text).toContain(en.importStatusImported)
    expect(text).toContain('alpha')
    expect(text).not.toContain(en.renderError)
    expect(container.querySelectorAll('.sm-panel').length).toBeGreaterThan(0)
  })
})
