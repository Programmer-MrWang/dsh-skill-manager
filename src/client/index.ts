/**
 * Skill Manager browser surface — one additive `settings.section` page.
 *
 * The page reads and writes the `skillManager` Remote namespace exclusively
 * through detached JSON DTOs. All copy is locale-owned (`en`/`zh`); no
 * absolute path or live object crosses the wire.
 *
 * @module dsh-skill-manager/client
 */

import { Component, createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { en, zh, type SkillManagerLocaleKey } from './locales.js'
import { STYLE_CSS, STYLE_TAG } from './styles.js'
import {
  codec,
  invocation,
  param,
  parseCandidateView,
  parseDiagnostics,
  parseDraft,
  parseImportRequest,
  parseImportResult,
  parsePolicyDocument,
  parseSnapshot,
  parseSnapshotRequest,
  parseString,
  parseTrashView,
  unwrap,
  type PolicyScopeOption,
  type SkillCandidateView,
  type SkillDraftView,
  type SkillImportRequest,
  type SkillImportResult,
  type SkillManagerSnapshot,
  type SnapshotRequest,
  type TrashView,
  type WireContribution,
  type WireDescriptor,
} from '../wire.js'
import type {
  PolicyContext,
  PolicyDocumentV1,
  PolicyLayer,
  PolicyMode,
  PolicyState,
} from '../types.js'

const NS = 'settings.skills'
const SERVICE = 'skillManager'
const PACKAGE = 'dsh-skill-manager'

/** Required browser services. */
export const inject = ['slots', 'locale', 'remote']

/** Typed page of the mounted snapshot. */
interface DraftResult {
  readonly candidate: SkillCandidateView
  readonly draft: SkillDraftView
  readonly version: string
  readonly diagnostics: readonly { code: string; message: string }[]
}

interface ValidateResult {
  readonly diagnostics: readonly { code: string; message: string }[]
}

interface PolicyWriteResult {
  readonly revision: number
  readonly document: PolicyDocumentV1 | null
}

/** Layer being edited in the Policies view. */
interface LayerTarget {
  readonly scope: 'global' | 'preset' | 'workspace' | 'session'
  readonly key: string | null
}

interface EditorState {
  readonly mode: 'create' | 'edit'
  readonly candidate?: SkillCandidateView
  readonly rootId: string
  readonly layout: 'bundle' | 'flat'
  readonly version?: string
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly frontmatterText: string
  readonly metadataText: string
  readonly body: string
}

interface CopyState {
  readonly candidateId: string
  readonly sourceName: string
  readonly name: string
  readonly rootId: string
}

/* ------------------------------- codecs -------------------------------- */

const parseOk = (value: unknown): 'ok' => {
  if (value !== 'ok') throw new Error('expected ok')
  return value
}
const parseDraftResult = (value: unknown): DraftResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('draft result must be an object')
  const v = value as Record<string, unknown>
  if (typeof v.candidate === 'undefined' || typeof v.draft === 'undefined' || typeof v.version !== 'string') {
    throw new Error('draft result is incomplete')
  }
  return {
    candidate: parseCandidateView(v.candidate),
    draft: parseDraft(v.draft),
    version: v.version,
    diagnostics: parseDiagnostics(v.diagnostics),
  }
}
const parseValidateResult = (value: unknown): ValidateResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('validate result must be an object')
  const diagnostics = (value as Record<string, unknown>).diagnostics
  if (diagnostics === undefined) throw new Error('validate result is incomplete')
  return { diagnostics: parseDiagnostics(diagnostics) }
}
const parsePolicyWrite = (value: unknown): PolicyWriteResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy write must be an object')
  const v = value as Record<string, unknown>
  if (typeof v.revision !== 'number' || !Number.isFinite(v.revision)) throw new Error('policy write revision is invalid')
  return {
    revision: v.revision,
    document: v.document === null ? null : parsePolicyDocument(v.document),
  }
}
const parseLayerRequest = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('setLayer request must be an object')
  const v = value as Record<string, unknown>
  if (v.scope !== 'global' && v.scope !== 'preset' && v.scope !== 'workspace' && v.scope !== 'session') {
    throw new Error('setLayer request.scope is invalid')
  }
  if (v.mode !== null && v.mode !== 'inherit' && v.mode !== 'all' && v.mode !== 'allow-list' && v.mode !== 'deny-list') {
    throw new Error('setLayer request.mode is invalid')
  }
  if (v.states !== undefined && (v.states === null || typeof v.states !== 'object' || Array.isArray(v.states))) {
    throw new Error('setLayer request.states must be an object')
  }
  return value
}

/** Contribution mounted on the browser Remote service. */
export function skillManagerContribution(): WireContribution {
  const text = codec<string>('String', value => parseString(value, 'value'))
  const layout = codec<'bundle' | 'flat'>('Layout', value => {
    if (value !== 'bundle' && value !== 'flat') throw new Error('layout must be bundle or flat')
    return value
  })
  const draft = codec<SkillDraftView>('Draft', value => parseDraft(value))
  const snapshotRequest = codec<SnapshotRequest>('SnapshotRequest', value => parseSnapshotRequest(value))
  const layerRequest = codec<unknown>('SetLayerRequest', value => parseLayerRequest(value))
  const ok = codec<'ok'>('Ok', parseOk)
  const descriptors: WireDescriptor[] = [
    invocation('snapshot', [param('request', snapshotRequest)], codec('Snapshot', parseSnapshot)),
    invocation('readDraft', [param('candidateId', text)], codec('DraftResult', parseDraftResult)),
    invocation('validateDraft', [param('draft', draft)], codec('ValidateResult', parseValidateResult)),
    invocation('create', [param('rootId', text), param('draft', draft), param('layout', layout)], codec('DraftResult', parseDraftResult)),
    invocation('update', [param('candidateId', text), param('expectedVersion', text), param('draft', draft)], codec('DraftResult', parseDraftResult)),
    invocation('copy', [param('candidateId', text), param('rootId', text), param('newName', text)], codec('DraftResult', parseDraftResult)),
    invocation('trash', [param('candidateId', text), param('expectedVersion', text)], codec('TrashView', parseTrashView)),
    invocation('restore', [param('trashId', text)], codec('DraftResult', parseDraftResult)),
    invocation('deletePermanently', [param('trashId', text)], codec('Ok', parseOk)),
    invocation('setLayer', [param('request', layerRequest)], codec('PolicyWrite', parsePolicyWrite)),
    invocation('importFolders', [
      param('request', codec<SkillImportRequest>('ImportRequest', value => parseImportRequest(value))),
    ], codec<SkillImportResult>('ImportResult', value => parseImportResult(value))),
  ]
  return { package: PACKAGE, descriptors }
}

/** Minimal structural view of the mounted Remote namespace service. */
type RemoteNamespace = Record<string, (args?: unknown) => Promise<unknown>>

/** Transport envelope view shared by every Remote call. */
interface Envelope<Value> {
  readonly ok: boolean
  readonly value?: Value
}

/** Error raised by unwrap carries the stable domain code when present. */
type CodedError = Error & { readonly code?: string }

/* ------------------------------ section ui ----------------------------- */

/** Kinds of a snapshot's managed candidates. */
const KIND_KEYS: Record<string, SkillManagerLocaleKey> = {
  'user-dsh': 'sourceUserDsh',
  'user-agents': 'sourceUserAgents',
  'workspace-dsh': 'sourceWorkspaceDsh',
  'workspace-agents': 'sourceWorkspaceAgents',
}

/** Shared section state living in one component. */
export interface SkillManagerSectionProps {
  /** Shell affordance: close the settings panel. */
  readonly close?: () => void
}

/** API handed to the section by its registration closure. */
interface SectionApi {
  snapshot(request: SnapshotRequest): Promise<SkillManagerSnapshot>
  readDraft(candidateId: string): Promise<DraftResult>
  validateDraft(draft: unknown): Promise<ValidateResult>
  create(rootId: string, draft: unknown, layout: 'bundle' | 'flat'): Promise<DraftResult>
  update(candidateId: string, version: string, draft: unknown): Promise<DraftResult>
  copy(candidateId: string, rootId: string, newName: string): Promise<DraftResult>
  trash(candidateId: string, version: string): Promise<TrashView>
  restore(trashId: string): Promise<DraftResult>
  deletePermanently(trashId: string): Promise<'ok'>
  setLayer(request: unknown): Promise<PolicyWriteResult>
  importFolders(request: SkillImportRequest): Promise<SkillImportResult>
}

/** Structural view of the Host's native directory picker namespace. */
interface FolderPicker {
  readonly pick?: () => Promise<string | null>
}

/**
 * Mount the section: register its locale dictionaries, bridge the Remote
 * namespace, and register the `settings.section` entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: {
  readonly slots: {
    readonly inject: (name: string, register: () => unknown) => unknown
    readonly register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  readonly locale: {
    readonly register: (ns: string, dictionaries: { zh: unknown; en: unknown }) => unknown
    readonly bind: (ns: string) => (key: SkillManagerLocaleKey) => string
  }
  readonly remote: {
    readonly $mount: (contribution: WireContribution) => Promise<() => Promise<void>>
  }
  readonly effect: (callback: () => unknown, label: string) => unknown
}): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PACKAGE}: dictionaries`)

  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void ready.catch(() => {})
  ctx.effect(async () => {
    try {
      const dispose = await ctx.remote.$mount(skillManagerContribution())
      resolveReady()
      return async () => { await dispose() }
    } catch (error) {
      rejectReady(error)
      throw error
    }
  }, `${PACKAGE}: remote bridge`)

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    await ready
    const namespace = (ctx as unknown as { get: (key: string) => unknown }).get(`remote.${SERVICE}`) as RemoteNamespace | undefined
    if (namespace === undefined || typeof namespace[method] !== 'function') {
      throw new Error(`The skill manager service mounted without the ${method} method.`)
    }
    const result = await namespace[method](...(args as [unknown]))
    return unwrap(result as Envelope<unknown>)
  }

  const api: SectionApi = {
    snapshot: async request => parseSnapshot(await call('snapshot', [request])),
    readDraft: async candidateId => parseDraftResult(await call('readDraft', [candidateId])),
    validateDraft: async draft => parseValidateResult(await call('validateDraft', [draft])),
    create: async (rootId, draft, layout) => parseDraftResult(await call('create', [rootId, draft, layout])),
    update: async (candidateId, version, draft) => parseDraftResult(await call('update', [candidateId, version, draft])),
    copy: async (candidateId, rootId, newName) => parseDraftResult(await call('copy', [candidateId, rootId, newName])),
    trash: async (candidateId, version) => parseTrashView(await call('trash', [candidateId, version])),
    restore: async trashId => parseDraftResult(await call('restore', [trashId])),
    deletePermanently: async trashId => parseOk(await call('deletePermanently', [trashId])),
    setLayer: async request => parsePolicyWrite(await call('setLayer', [request])),
    importFolders: async request => parseImportResult(await call('importFolders', [request])),
  }

  /** Open the Host's native folder chooser; null means the operator cancelled. */
  const pickFolder = async (): Promise<string | null> => {
    const picker = (ctx as unknown as { get: (key: string) => unknown }).get('remote.directoryPicker') as FolderPicker | undefined
    if (picker?.pick === undefined) throw new Error('This deployment has no native folder picker.')
    return await unwrapPickedPath(await picker.pick())
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'skills', order: 30, label: () => t('nav'), locale: NS },
      (props: SkillManagerSectionProps) => h(SkillSectionBoundary, {
        message: t('renderError'),
        children: h(Section, { ...props, t, api, pickFolder }),
      }),
    ))
}

/* ----------------------------- page views ------------------------------ */

type ViewId = 'installed' | 'policies' | 'editor' | 'trash'
type LayerScope = 'global' | 'preset' | 'workspace' | 'session'

/** Main section component. */
function Section(props: {
  readonly t: (key: SkillManagerLocaleKey) => string
  readonly api: SectionApi
  readonly pickFolder: () => Promise<string | null>
  readonly close?: () => void
}): ReactNode {
  const { t, api } = props
  const [view, setView] = useState<ViewId>('installed')
  const [snapshot, setSnapshot] = useState<SkillManagerSnapshot | null>(null)
  const [request, setRequest] = useState<SnapshotRequest>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [copyFrom, setCopyFrom] = useState<CopyState | null>(null)
  const [trashConfirmId, setTrashConfirmId] = useState<string | null>(null)
  const [permanentConfirmId, setPermanentConfirmId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [layerTarget, setLayerTarget] = useState<LayerTarget>({ scope: 'global', key: null })
  const [layerMode, setLayerMode] = useState<PolicyMode>('inherit')
  const [layerStates, setLayerStates] = useState<Record<string, PolicyState>>({})
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [stagedPaths, setStagedPaths] = useState<string[]>([])
  const [importRootId, setImportRootId] = useState('')
  const [importResult, setImportResult] = useState<SkillImportResult | null>(null)

  const injectStyle = (): void => {
    if (typeof document === 'undefined') return
    const id = `${STYLE_TAG}-css`
    if (document.getElementById(id) !== null) return
    const tag = document.createElement('style')
    tag.id = id
    tag.dataset.plugin = PACKAGE
    tag.textContent = STYLE_CSS
    document.head.appendChild(tag)
  }
  useEffect(() => { injectStyle() }, [])

  const fail = (candidate: unknown): CodedError => candidate as CodedError
  const runAction = async (action: () => Promise<void>, okText: string | null): Promise<void> => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (okText !== null) setNotice(okText)
    } catch (candidate) {
      const caught = fail(candidate)
      if (caught?.code === 'CONFLICT') setError(t('conflict'))
      else setError(caught?.message || t('errorSave'))
    } finally {
      setSaving(false)
    }
  }

  const reload = async (nextRequest = request): Promise<void> => {
    setBusy(true)
    setLoadError(null)
    setError(null)
    try {
      const next = await api.snapshot(nextRequest)
      setSnapshot(next)
      setRequest(nextRequest)
    } catch (candidate) {
      setLoadError(fail(candidate).message || t('errorLoad'))
    } finally {
      setBusy(false)
    }
  }

  /** Open the folder-import staging panel with a default target root. */
  const openImport = (): void => {
    setImportOpen(true)
    setImportResult(null)
    if (importRootId === '' || !rootOptions.some(root => root.id === importRootId)) {
      setImportRootId(writableRoots[0]?.id ?? '')
    }
  }

  /** Ask the native picker for one folder and stage it. */
  const stageFolder = async (): Promise<void> => {
    await runAction(async () => {
      const path = await props.pickFolder()
      if (path === null) return
      setStagedPaths(previous => previous.includes(path) ? previous : [...previous, path])
      setImportResult(null)
    }, null)
  }

  const dropStaged = (index: number): void => {
    setStagedPaths(previous => previous.filter((_, i) => i !== index))
    setImportResult(null)
  }

  /** Import every staged folder into the chosen root. */
  const runImport = async (): Promise<void> => {
    if (stagedPaths.length === 0 || importRootId === '') return
    setImportResult(null)
    await runAction(async () => {
      const result = await api.importFolders({ paths: stagedPaths, rootId: importRootId })
      setImportResult(result)
      await reload(request)
    }, t('noticeImported'))
  }
  useEffect(() => {
    void reload({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Current request as a policy context for previews. */
  const context: PolicyContext = useMemo(() => {
    if (snapshot === null) return {}
    return snapshot.context
  }, [snapshot])

  const rootOptions = snapshot?.roots ?? []
  const writableRoots = rootOptions.filter(root => root.writable)
  const effectiveRows = snapshot?.effective ?? []
  const candidateRows = snapshot?.candidates ?? []
  const trashRows = snapshot?.trash ?? []

  const effectiveByName = useMemo(() => {
    const map = new Map<string, SkillManagerSnapshot['effective'][number]>()
    for (const row of effectiveRows) map.set(row.name, row)
    return map
  }, [snapshot])

  /** Effective invocation flags of one catalog row. */
  const flagsOf = (row: {
    author: { modelInvocable: boolean; userInvocable: boolean }
    effectiveInvocation?: { modelInvocable: boolean; userInvocable: boolean }
  }): { modelInvocable: boolean; userInvocable: boolean } => row.effectiveInvocation ?? row.author

  /** Status classification of one managed candidate. */
  const candidateStatus = (
    candidate: SkillCandidateView,
    effective: SkillManagerSnapshot['effective'][number] | undefined,
  ): string => {
    if (candidate.diagnostics.length > 0) return 'invalid'
    if (candidate.invocation.modelInvocable === false && candidate.invocation.userInvocable === false) return 'disabled'
    if (effective === undefined) return 'shadowed'
    const flags = flagsOf(effective)
    const sameAuthor = flags.modelInvocable === candidate.invocation.modelInvocable
      && flags.userInvocable === candidate.invocation.userInvocable
    if (!sameAuthor) return effective.effectiveInvocation === undefined ? 'shadowed' : 'restricted'
    return 'effective'
  }

  const statusKeyOf = (status: string): SkillManagerLocaleKey => {
    if (status === 'invalid') return 'statusInvalid'
    if (status === 'disabled') return 'statusDisabled'
    if (status === 'shadowed') return 'statusShadowed'
    if (status === 'restricted') return 'statusRestricted'
    return 'statusEffective'
  }

  const badgeClass = (tone: string): string => {
    if (tone === 'invalid' || tone === 'disabled' || tone === 'bad') return 'sm-badge sm-badge-bad'
    if (tone === 'restricted' || tone === 'warn' || tone === 'ro') return 'sm-badge sm-badge-warn'
    if (tone === 'shadowed') return 'sm-badge sm-badge-mute'
    return 'sm-badge sm-badge-ok'
  }

  const candidateBadges = (candidate: SkillCandidateView): ReactNode[] => {
    const badges: ReactNode[] = []
    const effective = effectiveByName.get(candidate.name)
    const status = candidateStatus(candidate, effective)
    if (status !== 'effective') {
      badges.push(h('span', { key: 'status', className: badgeClass(status) }, t(statusKeyOf(status))))
    }
    if (!candidate.editable) badges.push(h('span', { key: 'ro', className: badgeClass('ro') }, t('readOnly')))
    badges.push(h('span', { key: 'kind', className: badgeClass('kind') },
      t(KIND_KEYS[candidate.source] ?? 'sourceOther')))
    return badges
  }

  /** Effective row badges. */
  const effectiveBadges = (row: SkillManagerSnapshot['effective'][number]): ReactNode[] => {
    const badges: ReactNode[] = []
    const flags = flagsOf(row)
    const restricted = row.effectiveInvocation !== undefined
    const disabled = flags.modelInvocable === false && flags.userInvocable === false
    if (disabled) badges.push(h('span', { key: 'disabled', className: badgeClass('bad') }, t('statusDisabled')))
    else if (restricted) badges.push(h('span', { key: 'restricted', className: badgeClass('warn') }, t('statusRestricted')))
    else badges.push(h('span', { key: 'effective', className: badgeClass('ok') }, t('statusEffective')))
    badges.push(h('span', { key: 'kind', className: 'sm-badge sm-badge-mute' },
      t(KIND_KEYS[row.source] ?? 'sourceOther')))
    return badges
  }

  const visibleCandidates = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return candidateRows.filter(candidate => {
      if (sourceFilter !== 'all' && candidate.source !== sourceFilter) return false
      if (needle !== '' && !candidate.name.includes(needle)
        && !candidate.description.toLowerCase().includes(needle)) return false
      const effective = effectiveByName.get(candidate.name)
      const status = candidateStatus(candidate, effective)
      if (statusFilter !== 'all' && status !== statusFilter) return false
      return true
    })
  }, [candidateRows, effectiveByName, search, sourceFilter, statusFilter])

  const visibleEffective = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return effectiveRows.filter(row => {
      if (needle !== '' && !row.name.includes(needle)
        && !row.description.toLowerCase().includes(needle)) return false
      return true
    })
  }, [effectiveRows, search])

  const policyDocument = snapshot?.document ?? null

  /** Selected policy layer from the current document. */
  const selectedLayer: PolicyLayer | undefined = useMemo(() => {
    if (policyDocument === null) return undefined
    if (layerTarget.scope === 'global') return policyDocument.global
    const key = layerTarget.key
    if (key === null) return undefined
    if (layerTarget.scope === 'preset') return policyDocument.presets?.[key]
    if (layerTarget.scope === 'workspace') return policyDocument.workspaces?.[key]
    return policyDocument.sessions?.[key]
  }, [policyDocument, layerTarget])

  /** Layer of a document (undefined when absent). */
  const layerOf = (document: PolicyDocumentV1 | null, target: LayerTarget): PolicyLayer | undefined => {
    if (document === null) return undefined
    if (target.scope === 'global') return document.global
    const key = target.key
    if (key === null) return undefined
    if (target.scope === 'preset') return document.presets?.[key]
    if (target.scope === 'workspace') return document.workspaces?.[key]
    return document.sessions?.[key]
  }

  /** Select a layer: reset drafts to its stored values. */
  const selectLayer = (target: LayerTarget): void => {
    setLayerTarget(target)
    const layer = layerOf(policyDocument, target)
    setLayerMode(layer?.mode ?? 'inherit')
    setLayerStates({ ...(layer?.skills ?? {}) })
  }

  /** Scope option list with stable keys. */
  const scopeOptionEntries = snapshot?.scopeOptions ?? []

  const resetLayer = (): void => {
    setLayerMode('inherit')
    setLayerStates({})
  }

  const savePolicy = async (): Promise<void> => {
    const states: Record<string, PolicyState | null> = {}
    for (const [name, state] of Object.entries(layerStates)) {
      if (state !== 'inherit') states[name] = state
    }
    await runAction(async () => {
      const revision = snapshot?.revision ?? 0
      await api.setLayer({
        scope: layerTarget.scope,
        key: layerTarget.scope === 'global' ? null : layerTarget.key,
        mode: layerMode === 'inherit' ? null : layerMode,
        states,
        expectedRevision: revision,
      })
      await reload(request)
    }, t('noticeSaved'))
  }

  /** Editor state initialization helpers. */
  const blankEditor = (rootId?: string, layout?: 'bundle' | 'flat'): EditorState => ({
    mode: 'create',
    rootId: rootId ?? writableRoots[0]?.id ?? '',
    layout: layout ?? 'bundle',
    name: '',
    description: '',
    whenToUse: '',
    modelInvocable: true,
    userInvocable: true,
    frontmatterText: '',
    metadataText: '',
    body: '',
  })

  const openNew = (): void => {
    setEditor(blankEditor())
    setView('editor')
  }

  const openEdit = async (candidateId: string): Promise<void> => {
    await runAction(async () => {
      const result = await api.readDraft(candidateId)
      setEditor({
        mode: 'edit',
        candidate: result.candidate,
        rootId: result.candidate.rootId,
        layout: result.candidate.layout,
        version: result.version,
        name: result.draft.name,
        description: result.draft.description,
        whenToUse: result.draft.whenToUse ?? '',
        modelInvocable: result.draft.invocation?.modelInvocable ?? true,
        userInvocable: result.draft.invocation?.userInvocable ?? true,
        frontmatterText: JSON.stringify(result.draft.frontmatter ?? {}, null, 2),
        metadataText: JSON.stringify(result.draft.metadata ?? {}, null, 2),
        body: result.draft.body,
      })
      setView('editor')
    }, null)
  }

  const beginCopy = (candidate: SkillCandidateView): void => {
    setCopyFrom({
      candidateId: candidate.id,
      sourceName: candidate.name,
      name: `${candidate.name}-copy`,
      rootId: candidate.rootId,
    })
  }

  /** Validate and submit the editor draft. */
  const saveEditor = async (): Promise<void> => {
    if (editor === null) return
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editor.name)) {
      setError(t('editorNameMismatch'))
      return
    }
    let frontmatter: Record<string, unknown> | undefined
    try {
      const text = editor.frontmatterText.trim()
      if (text !== '') {
        const parsed = JSON.parse(text) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        frontmatter = parsed as Record<string, unknown>
      }
    } catch {
      setError(t('editorInvalidJson'))
      return
    }
    let metadata: Record<string, unknown> | undefined
    try {
      const text = editor.metadataText.trim()
      if (text !== '') {
        const parsed = JSON.parse(text) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      setError(t('editorInvalidJson'))
      return
    }
    const draft: unknown = {
      name: editor.name,
      description: editor.description,
      ...(editor.whenToUse.trim() === '' ? {} : { whenToUse: editor.whenToUse.trim() }),
      invocation: { modelInvocable: editor.modelInvocable, userInvocable: editor.userInvocable },
      ...(frontmatter === undefined ? {} : { frontmatter }),
      ...(metadata === undefined ? {} : { metadata }),
      body: editor.body,
    }
    await runAction(async () => {
      if (editor.mode === 'create') {
        await api.create(editor.rootId, draft, editor.layout)
      } else {
        if (editor.candidate === undefined || editor.version === undefined) return
        await api.update(editor.candidate.id, editor.version, draft)
      }
      await reload(request)
      setEditor(null)
      setView('installed')
    }, editor.mode === 'create' ? t('noticeCreated') : t('noticeUpdated'))
  }

  /** Submit a copy. */
  const saveCopy = async (): Promise<void> => {
    if (copyFrom === null) return
    await runAction(async () => {
      await api.copy(copyFrom.candidateId, copyFrom.rootId, copyFrom.name)
      await reload(request)
      setCopyFrom(null)
    }, t('noticeCopied'))
  }

  /** Move one candidate to trash. */
  const trashCandidate = async (candidate: SkillCandidateView): Promise<void> => {
    await runAction(async () => {
      if (candidate.version === undefined) return
      await api.trash(candidate.id, candidate.version)
      await reload(request)
    }, t('noticeTrashed'))
  }

  /** Restore one trash entry. */
  const restoreEntry = async (entry: TrashView): Promise<void> => {
    await runAction(async () => {
      await api.restore(entry.id)
      await reload(request)
    }, t('noticeRestored'))
  }

  /** Permanently delete one trash entry. */
  const deleteEntry = async (entry: TrashView): Promise<void> => {
    await runAction(async () => {
      await api.deletePermanently(entry.id)
      setPermanentConfirmId(null)
      await reload(request)
    }, t('noticeDeleted'))
  }

  const sourceOptions: ReactNode[] = [
    h('option', { key: 'all', value: 'all' }, t('allSources')),
    ...(rootOptions.map(root => h('option', { key: root.id, value: root.kind }, t(KIND_KEYS[root.kind] ?? 'sourceOther')))),
  ]
  const statusOptions: ReactNode[] = [
    h('option', { key: 'all', value: 'all' }, t('allStatuses')),
    h('option', { key: 'effective', value: 'effective' }, t('statusEffective')),
    h('option', { key: 'restricted', value: 'restricted' }, t('statusRestricted')),
    h('option', { key: 'shadowed', value: 'shadowed' }, t('statusShadowed')),
    h('option', { key: 'invalid', value: 'invalid' }, t('statusInvalid')),
  ]

  const tabs: ReactNode[] = (['installed', 'policies', 'editor', 'trash'] as const).map(id => (
    h('button', {
      key: id,
      type: 'button',
      role: 'tab',
      'aria-selected': view === id,
      className: 'sm-tab',
      onClick: () => { setView(id) },
    }, t(`tab${id[0]?.toUpperCase()}${id.slice(1)}` as SkillManagerLocaleKey))
  ))

  const body = (): ReactNode => {
    if (loadError !== null) {
      return h('p', { className: 'sm-status sm-status-err' }, `${t('errorLoad')} ${loadError}`)
    }
    if (snapshot === null || busy) {
      return h('p', { className: 'sm-empty' }, t('loading'))
    }
    if (view === 'installed') return installedView()
    if (view === 'policies') return policiesView()
    if (view === 'trash') return trashView()
    return editorView()
  }

  /** Installed view: effective catalog + managed files. */
  const installedView = (): ReactNode => {
    const rows: ReactNode[] = visibleEffective.map(row => {
      const flags = flagsOf(row)
      const modelAllowed = row.model.allowed
      const userAllowed = row.user.allowed
      return h('div', { key: row.name, className: 'sm-row' },
        h('div', { className: 'sm-row-body' },
          h('div', { className: 'sm-row-title' },
            h('span', { className: 'sm-key' }, row.name),
            ...effectiveBadges(row),
          ),
          h('p', { className: 'sm-row-desc' }, row.description === '' ? t('noDescription') : row.description),
          h('div', { className: 'sm-row-sub' },
            h('span', null, `${t('previewModel')}: ${flags.modelInvocable ? t('allowed') : t('denied')}`),
            h('span', null, `${t('previewUser')}: ${flags.userInvocable ? t('allowed') : t('denied')}`),
            !modelAllowed && h('span', { className: 'sm-badge sm-badge-bad' }, t('model')),
            !userAllowed && h('span', { className: 'sm-badge sm-badge-warn' }, t('user')),
          ),
        ),
      )
    })
    const managedRows: ReactNode[] = visibleCandidates.map(candidate => {
      const status = candidateStatus(candidate, effectiveByName.get(candidate.name))
      return h('div', { key: candidate.id, className: 'sm-row' },
        h('div', { className: 'sm-row-body' },
          h('div', { className: 'sm-row-title' },
            h('span', { className: 'sm-key' }, candidate.name),
            ...candidateBadges(candidate),
          ),
          h('p', { className: 'sm-row-desc' }, candidate.description === '' ? t('noDescription') : candidate.description),
          h('div', { className: 'sm-row-sub' },
            h('span', null, candidate.layout === 'bundle' ? t('layoutBundle') : t('layoutFlat')),
            candidate.version !== undefined && h('span', { className: 'sm-badge sm-badge-mute' }, `${t('version')} ${candidate.version.slice(0, 8)}`),
          ),
          candidate.diagnostics.length > 0 && h('div', { className: 'sm-diagnostics' },
            ...candidate.diagnostics.map((diagnostic, index) =>
              h('div', { key: `${candidate.id}-d${index}` }, `[${diagnostic.code}] ${diagnostic.message}`))),
        ),
        h('div', { className: 'sm-row-actions' },
          candidate.editable && h('button', { type: 'button', className: 'sm-button', disabled: saving,
            onClick: () => { void openEdit(candidate.id) } }, t('edit')),
          h('button', { type: 'button', className: 'sm-button', disabled: saving,
            onClick: () => { beginCopy(candidate) } }, t('copy')),
          candidate.editable && candidate.version !== undefined && status !== 'shadowed'
            && h('button', { type: 'button', className: 'sm-button sm-button-danger', disabled: saving,
              onClick: () => { void trashCandidate(candidate) } }, t('moveToTrash')),
        ),
      )
    })
    return h('div', null,
      h('div', { className: 'sm-toolbar' },
        h('input', { className: 'sm-input sm-grow', value: search, placeholder: t('searchPlaceholder'),
          'aria-label': t('search'), onChange: (event: { target: { value: string } }) => setSearch(event.target.value) }),
        h('select', { className: 'sm-select', value: sourceFilter, 'aria-label': t('allSources'),
          onChange: (event: { target: { value: string } }) => setSourceFilter(event.target.value) }, ...sourceOptions),
        h('select', { className: 'sm-select', value: statusFilter, 'aria-label': t('allStatuses'),
          onChange: (event: { target: { value: string } }) => setStatusFilter(event.target.value) }, ...statusOptions),
        h('button', { type: 'button', className: 'sm-button', disabled: saving || writableRoots.length === 0,
          onClick: openImport }, t('importFolders')),
        h('button', { type: 'button', className: 'sm-button sm-button-primary', disabled: saving || writableRoots.length === 0,
          onClick: openNew }, t('create')),
      ),
      h('div', { className: 'sm-panel' },
        h('h3', null, t('catalogTitle')),
        h('p', { className: 'sm-hint' }, t('catalogIntro')),
        visibleEffective.length === 0 ? h('p', { className: 'sm-empty' }, t('emptyEffective')) : h('div', null, ...rows),
      ),
      h('div', { className: 'sm-panel' },
        h('h3', null, t('managedTitle')),
        h('p', { className: 'sm-hint' }, t('managedIntro')),
        visibleCandidates.length === 0
          ? h('p', { className: 'sm-empty' }, search === '' ? t('emptyManaged') : t('emptySearch'))
          : h('div', null, ...managedRows),
      ),
    )
  }

  /** Policies view: layer editor + preview context. */
  const policiesView = (): ReactNode => {
    const contextText = context.session !== undefined
      ? context.session
      : context.preset !== undefined
        ? context.preset
        : context.workspace !== undefined
          ? context.workspace
          : ''
    const layerRows: ReactNode[] = effectiveRows.map(row => {
      const name = row.name
      const stored = selectedLayer?.skills?.[name]
      const value: PolicyState = layerStates[name] ?? stored ?? 'inherit'
      return h('div', { key: name, className: 'sm-layer-row' },
        h('label', { className: 'sm-field', style: { flex: '1 1 200px' } },
          h('span', { className: 'sm-key' }, name),
        ),
        h('select', { className: 'sm-select', value,
          'aria-label': name,
          onChange: (event: { target: { value: string } }) => {
            setLayerStates(previous => ({ ...previous, [name]: event.target.value as PolicyState }))
          } },
        h('option', { value: 'inherit' }, t('stateInherit')),
        h('option', { value: 'allow' }, t('stateAllow')),
        h('option', { value: 'deny' }, t('stateDeny')),
        ),
      )
    })
    const scopedOptions: ReactNode[] = scopeOptionEntries.map(option =>
      h('option', { key: `${option.scope}:${option.id}`, value: `${option.scope}\u0000${option.id}` },
        `${scopeLabel(option.scope, t)} · ${option.id}`))
    const effectivePreviewRows: ReactNode[] = effectiveRows.map(row => {
      const flags = flagsOf(row)
      return h('div', { key: `preview-${row.name}`, className: 'sm-row' },
        h('div', { className: 'sm-row-body' },
          h('div', { className: 'sm-row-title' }, h('span', { className: 'sm-key' }, row.name)),
          h('div', { className: 'sm-row-sub' },
            h('span', { className: flags.modelInvocable ? 'sm-badge sm-badge-ok' : 'sm-badge sm-badge-bad' },
              `${t('model')} · ${flags.modelInvocable ? t('allowed') : t('denied')}`),
            h('span', { className: flags.userInvocable ? 'sm-badge sm-badge-ok' : 'sm-badge sm-badge-bad' },
              `${t('user')} · ${flags.userInvocable ? t('allowed') : t('denied')}`),
          ),
        ),
      )
    })
    return h('div', null,
      h('p', { className: 'sm-rule' }, t('policyIntro')),
      h('div', { className: 'sm-panel' },
        h('h3', null, t('scopeLayer')),
        h('div', { className: 'sm-layer-row' },
          h('select', {
            className: 'sm-select', style: { minWidth: '12rem' },
            'aria-label': t('scopeLayer'),
            value: layerTarget.scope === 'global' ? 'global' : `${layerTarget.scope}\u0000${layerTarget.key ?? ''}`,
            onChange: (event: { target: { value: string } }) => {
              const value = event.target.value
              if (value === 'global') selectLayer({ scope: 'global', key: null })
              else {
                const separator = value.indexOf('\u0000')
                const scope = separator < 0 ? value : value.slice(0, separator)
                const key = separator < 0 ? '' : value.slice(separator + 1)
                selectLayer({ scope: scope as LayerScope, key })
              }
            },
          },
            h('option', { value: 'global' }, t('scopeGlobal')),
            ...scopedOptions,
          ),
          contextText !== '' && h('span', { className: 'sm-badge sm-badge-mute' },
            `${t('policyContext')}: ${contextText}`),
        ),
        h('p', { className: 'sm-rule' }, t('policyMode')),
        h('div', { className: 'sm-layer-row' },
          h('select', {
            className: 'sm-select', 'aria-label': t('policyMode'),
            value: layerMode,
            onChange: (event: { target: { value: string } }) => setLayerMode(event.target.value as PolicyMode),
          },
            h('option', { value: 'inherit' }, t('modeInherit')),
            h('option', { value: 'all' }, t('modeAll')),
            h('option', { value: 'allow-list' }, t('modeAllowList')),
            h('option', { value: 'deny-list' }, t('modeDenyList')),
          ),
          h('button', { type: 'button', className: 'sm-button', disabled: saving, onClick: resetLayer }, t('policyReset')),
        ),
        h('h3', null, t('policyStates')),
        layerRows.length === 0 ? h('p', { className: 'sm-empty' }, t('policyEmptyLayer')) : h('div', null, ...layerRows),
        h('div', { className: 'sm-actions' },
          h('button', { type: 'button', className: 'sm-button sm-button-primary', disabled: saving, onClick: () => { void savePolicy() } },
            saving ? t('saving') : t('policySave')),
        ),
      ),
      h('div', { className: 'sm-panel' },
        h('h3', null, t('policyEffectivePreview')),
        contextText === '' && h('p', { className: 'sm-rule' }, t('policyContextNone')),
        effectivePreviewRows.length === 0
          ? h('p', { className: 'sm-empty' }, t('emptyEffective'))
          : h('div', null, ...effectivePreviewRows),
      ),
    )
  }

  /** Editor view. */
  const editorView = (): ReactNode => {
    if (editor === null) {
      return h('p', { className: 'sm-empty' }, t('editorNewTitle'))
    }
    const rootOptions = writableRoots.map(root => h('option', { key: root.id, value: root.id }, root.label))
    const set = (patch: Partial<EditorState>): void => {
      setEditor(previous => previous === null ? null : { ...previous, ...patch })
    }
    return h('div', { className: 'sm-panel' },
      h('h3', null, editor.mode === 'create' ? t('editorNewTitle') : t('editorEditTitle')),
      h('div', { className: 'sm-grid2' },
        h('label', { className: 'sm-field' },
          h('span', null, t('editorName')),
          h('input', { className: 'sm-input', value: editor.name, disabled: editor.mode === 'edit' || saving,
            placeholder: t('editorNamePlaceholder'), spellCheck: false,
            onChange: (event: { target: { value: string } }) => set({ name: event.target.value }) }),
        ),
        h('label', { className: 'sm-field' },
          h('span', null, t('editorDescription')),
          h('input', { className: 'sm-input', value: editor.description, disabled: saving,
            placeholder: t('editorDescriptionPlaceholder'),
            onChange: (event: { target: { value: string } }) => set({ description: event.target.value }) }),
        ),
        h('label', { className: 'sm-field' },
          h('span', null, t('editorWhenToUse')),
          h('input', { className: 'sm-input', value: editor.whenToUse, disabled: saving,
            placeholder: t('editorWhenToUsePlaceholder'),
            onChange: (event: { target: { value: string } }) => set({ whenToUse: event.target.value }) }),
        ),
        editor.mode === 'create' && h('label', { className: 'sm-field' },
          h('span', null, t('editorRoot')),
          h('select', { className: 'sm-select', value: editor.rootId, disabled: saving,
            onChange: (event: { target: { value: string } }) => set({ rootId: event.target.value }) }, ...rootOptions)),
        editor.mode === 'create' && h('label', { className: 'sm-field' },
          h('span', null, t('editorLayout')),
          h('select', { className: 'sm-select', value: editor.layout, disabled: saving,
            onChange: (event: { target: { value: string } }) => set({ layout: event.target.value as 'bundle' | 'flat' }) },
            h('option', { value: 'bundle' }, t('layoutBundle')),
            h('option', { value: 'flat' }, t('layoutFlat')),
          )),
      ),
      h('div', { className: 'sm-field' },
        h('span', null, t('editorInvocation')),
        h('label', { className: 'sm-check' },
          h('input', { type: 'checkbox', checked: editor.modelInvocable, disabled: saving,
            onChange: (event: { target: { checked: boolean } }) => set({ modelInvocable: event.target.checked }) }),
          h('span', null, t('editorModelInvokable')),
        ),
        h('label', { className: 'sm-check' },
          h('input', { type: 'checkbox', checked: editor.userInvocable, disabled: saving,
            onChange: (event: { target: { checked: boolean } }) => set({ userInvocable: event.target.checked }) }),
          h('span', null, t('editorUserInvokable')),
        ),
      ),
      h('label', { className: 'sm-field' },
        h('span', null, t('editorFrontmatter')),
        h('textarea', { className: 'sm-textarea', rows: 4, value: editor.frontmatterText, disabled: saving,
          placeholder: t('editorFrontmatterPlaceholder'), spellCheck: false,
          onChange: (event: { target: { value: string } }) => set({ frontmatterText: event.target.value }) }),
      ),
      h('label', { className: 'sm-field' },
        h('span', null, t('editorMetadata')),
        h('textarea', { className: 'sm-textarea', rows: 3, value: editor.metadataText, disabled: saving,
          spellCheck: false,
          onChange: (event: { target: { value: string } }) => set({ metadataText: event.target.value }) }),
      ),
      h('label', { className: 'sm-field' },
        h('span', null, t('editorBody')),
        h('textarea', { className: 'sm-textarea', rows: 14, value: editor.body, disabled: saving,
          placeholder: t('editorBodyPlaceholder'),
          onChange: (event: { target: { value: string } }) => set({ body: event.target.value }) }),
      ),
      h('div', { className: 'sm-actions' },
        h('button', { type: 'button', className: 'sm-button', disabled: saving,
          onClick: () => { setEditor(null); setView('installed') } }, t('discard')),
        h('button', { type: 'button', className: 'sm-button sm-button-primary', disabled: saving || editor.rootId === '',
          onClick: () => { void saveEditor() } },
          saving ? t('saving') : (editor.mode === 'create' ? t('createSkill') : t('updateSkill'))),
      ),
    )
  }

  /** Trash view. */
  const trashView = (): ReactNode => {
    const rows: ReactNode[] = trashRows.map(entry => {
      const pendingDelete = permanentConfirmId === entry.id
      return h('div', { key: entry.id, className: 'sm-row' },
        h('div', { className: 'sm-row-body' },
          h('div', { className: 'sm-row-title' },
            h('span', { className: 'sm-key' }, entry.name),
            h('span', { className: 'sm-badge sm-badge-mute' }, entry.layout === 'bundle' ? t('layoutBundle') : t('layoutFlat')),
          ),
          h('div', { className: 'sm-row-sub' },
            h('span', null, `${t('deletedAt')}: ${new Date(entry.deletedAt).toLocaleString()}`),
          ),
        ),
        h('div', { className: 'sm-row-actions' },
          h('button', { type: 'button', className: 'sm-button', disabled: saving,
            onClick: () => { void restoreEntry(entry) } }, t('restore')),
          pendingDelete
            ? h('span', { className: 'sm-trash-actions' },
              h('button', { type: 'button', className: 'sm-button sm-button-danger', disabled: saving,
                onClick: () => { void deleteEntry(entry) } }, t('confirm')),
              h('button', { type: 'button', className: 'sm-button', disabled: saving,
                onClick: () => { setPermanentConfirmId(null) } }, t('cancel')),
            )
            : h('button', { type: 'button', className: 'sm-button sm-button-danger', disabled: saving,
              onClick: () => { setPermanentConfirmId(entry.id) } }, t('deletePermanently')),
        ),
      )
    })
    return h('div', null,
      h('p', { className: 'sm-hint' }, t('trashIntro')),
      trashRows.length === 0 ? h('p', { className: 'sm-empty' }, t('emptyTrash')) : h('div', null, ...rows),
    )
  }

  /** Copy dialog rendered above the current view. */
  const copyDialog = copyFrom === null ? null : h('div', { className: 'sm-panel', key: 'copy' },
    h('h3', null, t('copyTitle')),
    h('div', { className: 'sm-grid2' },
      h('label', { className: 'sm-field' },
        h('span', null, t('copyName')),
        h('input', { className: 'sm-input', value: copyFrom.name, disabled: saving,
          placeholder: t('copyNamePlaceholder'), spellCheck: false,
          onChange: (event: { target: { value: string } }) => {
            setCopyFrom(previous => previous === null ? null : { ...previous, name: event.target.value })
          } }),
      ),
      h('label', { className: 'sm-field' },
        h('span', null, t('copyRoot')),
        h('select', { className: 'sm-select', value: copyFrom.rootId, disabled: saving,
          onChange: (event: { target: { value: string } }) => {
            setCopyFrom(previous => previous === null ? null : { ...previous, rootId: event.target.value })
          } },
          ...writableRoots.map(root => h('option', { key: root.id, value: root.id }, root.label))),
      ),
    ),
    h('div', { className: 'sm-dialog-actions' },
      h('button', { type: 'button', className: 'sm-button', disabled: saving,
        onClick: () => { setCopyFrom(null) } }, t('cancel')),
      h('button', { type: 'button', className: 'sm-button sm-button-primary', disabled: saving || copyFrom.name === '',
        onClick: () => { void saveCopy() } }, t('copyConfirm')),
    ),
  )

  /** Folder-import staging panel (only when import mode is open). */
  const importDialog = !importOpen ? null : h('div', { className: 'sm-panel', key: 'import' },
    h('h3', null, t('importTitle')),
    h('p', { className: 'sm-rule' }, t('importIntro')),
    h('div', { className: 'sm-layer-row' },
      h('label', { className: 'sm-field' },
        h('span', null, t('editorRoot')),
        h('select', { className: 'sm-select', value: importRootId, disabled: saving,
          onChange: (event: { target: { value: string } }) => {
            setImportRootId(event.target.value)
            setImportResult(null)
          } },
          ...writableRoots.map(root => h('option', { key: root.id, value: root.id }, root.label))),
      ),
    ),
    stagedPaths.length === 0
      ? h('p', { className: 'sm-empty' }, t('importEmpty'))
      : h('div', null, ...stagedPaths.map((path, index) => {
        const outcome = importResult?.items.find(item => item.index === index)
        const badge = outcome === undefined ? null
          : h('span', { className: importBadgeClass(outcome.status) }, t(importStatusKey(outcome.status)))
        const importedName = outcome !== undefined && outcome.name !== undefined && outcome.name !== folderBaseName(path)
          ? h('span', { className: 'sm-badge sm-badge-mute' }, `→ ${outcome.name}`)
          : null
        return h('div', { key: `${index}-${path}`, className: 'sm-layer-row' },
          h('span', { className: 'sm-key', style: { flex: '1 1 240px' } }, folderBaseName(path)),
          h('span', { className: 'sm-badge sm-badge-mute', style: { wordBreak: 'break-all' } }, path),
          badge,
          importedName,
          h('button', { type: 'button', className: 'sm-button', disabled: saving,
            onClick: () => { dropStaged(index) } }, t('importRemove')),
        )
      })),
    importResult !== null && h('p', { className: 'sm-rule' }, `${t('importSummary')}: ${String(importResult.imported)} / ${String(stagedPaths.length)}`),
    h('div', { className: 'sm-dialog-actions' },
      h('button', { type: 'button', className: 'sm-button', disabled: saving,
        onClick: () => { void stageFolder() } }, t('importPick')),
      h('button', { type: 'button', className: 'sm-button', disabled: saving,
        onClick: () => { setImportOpen(false); setStagedPaths([]); setImportResult(null) } }, t('close')),
      h('button', { type: 'button', className: 'sm-button sm-button-primary', disabled: saving || stagedPaths.length === 0 || importRootId === '',
        onClick: () => { void runImport() } }, saving ? t('saving') : t('importConfirm')),
    ),
  )

  const sectionTree = h('div', { className: 'sm' },
    h('p', { className: 'sm-hint' }, t('intro')),
    h('div', { className: 'sm-toolbar' },
      h('div', { className: 'sm-tabs', role: 'tablist' }, ...tabs),
      h('button', { type: 'button', className: 'sm-button', disabled: busy || saving,
        onClick: () => { void reload(request) } }, t('refresh')),
    ),
    notice !== null && h('p', { className: 'sm-status sm-status-ok', role: 'status' }, notice),
    error !== null && h('p', { className: 'sm-status sm-status-err', role: 'alert' }, error),
    copyDialog,
    importDialog,
    body(),
  )
  return sectionTree
}

/** Render error boundary for the section: blank pages become readable errors. */
interface SkillSectionBoundaryProps {
  readonly children: ReactNode
  readonly message: string
}

class SkillSectionBoundary extends Component<SkillSectionBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown): void {
    console.error('[dsh-skill-manager] section render failed', error)
    try {
      ;(globalThis as { __skillManagerLastError?: unknown }).__skillManagerLastError = error
    } catch {
      // Some sandboxes freeze globals; the visible boundary message still applies.
    }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const error = this.state.error
    return h('p', { className: 'sm-status sm-status-err', role: 'alert' },
      `${this.props.message} ${error.message} — ${error.stack?.split('\n')[1]?.trim() ?? ''}`)
  }
}

/** Status badge tone of one import outcome. */
function importBadgeClass(status: SkillImportResult['items'][number]['status']): string {
  if (status === 'imported') return 'sm-badge sm-badge-ok'
  if (status === 'conflict') return 'sm-badge sm-badge-warn'
  return 'sm-badge sm-badge-bad'
}

/** Locale key for one import outcome. */
function importStatusKey(status: SkillImportResult['items'][number]['status']): SkillManagerLocaleKey {
  if (status === 'imported') return 'importStatusImported'
  if (status === 'conflict') return 'importStatusConflict'
  if (status === 'invalid') return 'importStatusInvalid'
  return 'importStatusError'
}

/** Last non-empty path segment of an absolute folder path. */
function folderBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Normalize the native folder picker answer. Mounted namespace methods return
 * the transport envelope (`{ ok, value }`), and older deployments may return
 * the raw path; both are accepted, and non-string values degrade to null.
 */
export function unwrapPickedPath(result: unknown): string | null {
  if (typeof result === 'string') return result === '' ? null : result
  if (result === null || result === undefined) return null
  const envelope = result as { ok?: unknown; value?: unknown; error?: { message?: string } }
  if (envelope.ok === true) {
    return typeof envelope.value === 'string' && envelope.value !== '' ? envelope.value : null
  }
  if (envelope.ok === false) {
    throw new Error(envelope.error?.message ?? 'The folder picker failed.')
  }
  return null
}

/** Translate a scope kind for option labels. */
function scopeLabel(scope: PolicyScopeOption['scope'], t: (key: SkillManagerLocaleKey) => string): string {
  if (scope === 'preset') return t('scopePreset')
  if (scope === 'workspace') return t('scopeWorkspace')
  return t('scopeSession')
}

/* Keep type-level exports small and stable for consumers/tests. */
export type { DraftResult, ValidateResult, PolicyWriteResult, LayerTarget, EditorState }
export { Section as SkillManagerSection }
export { parseDraftResult, parseValidateResult, parsePolicyWrite, parseOk }
