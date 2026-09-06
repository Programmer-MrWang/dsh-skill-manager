/** Host-side filesystem discovery and mutation for locally authored skills. */
import { constants as fsConstants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export type SkillRootKind = 'user-dsh' | 'user-agents' | 'workspace-dsh' | 'workspace-agents'
export type SkillLayout = 'bundle' | 'flat'

export interface SkillInvocationDraft {
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillDraft {
  name: string
  description: string
  whenToUse?: string
  invocation?: Partial<SkillInvocationDraft>
  metadata?: Record<string, unknown>
  body: string
  /** Additional YAML fields preserved by the editor. Reserved fields are overwritten by the structured fields above. */
  frontmatter?: Record<string, unknown>
}

export interface SkillDiagnosticView {
  code: string
  message: string
}

export interface SkillRootView {
  id: string
  kind: SkillRootKind
  label: string
  writable: boolean
  available: boolean
}

export interface SkillCandidateView {
  id: string
  name: string
  description: string
  whenToUse?: string
  source: SkillRootKind
  provider: 'filesystem'
  rootId: string
  layout: SkillLayout
  editable: boolean
  deletable: boolean
  invocation: SkillInvocationDraft
  version?: string
  diagnostics: readonly SkillDiagnosticView[]
}

export interface SkillCandidateDraftView {
  candidate: SkillCandidateView
  draft: SkillDraft
  version: string
  /** Parse diagnostics for the draft read from disk, including name/path mismatch checks. */
  diagnostics: readonly SkillDiagnosticView[]
}

export interface TrashedSkillView {
  id: string
  name: string
  rootId: string
  layout: SkillLayout
  deletedAt: string
}

export interface SkillAuthoringOptions {
  dshHome: string
  agentsHome: string
  /** Canonical project directories whose `.dsh/skills` and `.agents/skills` roots are managed. */
  workspaceRoots?: readonly string[]
  /** Process-private entropy used to make path-free identifiers unguessable. */
  idSecret?: string | Uint8Array
  maxFileBytes?: number
  maxNameLength?: number
}

export type SkillAuthoringErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'CONTAINMENT_REFUSED'
  | 'TOO_LARGE'
  | 'UNAVAILABLE'

/** Stable failure returned by authoring operations without exposing Host paths. */
export class SkillAuthoringError extends Error {
  constructor(readonly code: SkillAuthoringErrorCode, message: string) {
    super(message)
    this.name = 'SkillAuthoringError'
  }
}

interface RootRecord {
  id: string
  kind: SkillRootKind
  label: string
  path: string
}

interface CandidateRecord {
  id: string
  root: RootRecord
  entryName: string
  skillName: string
  layout: SkillLayout
  entryPath: string
  filePath: string
}

interface ParsedDraft {
  draft: SkillDraft
  diagnostics: SkillDiagnosticView[]
}

interface TrashMetadata {
  version: 1
  id: string
  rootKind: SkillRootKind
  entryName: string
  name: string
  layout: SkillLayout
  deletedAt: string
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_NAME_LENGTH = 64
const TRASH_DIRECTORY = '.dsh-skill-manager-trash'
const TRASH_METADATA = 'entry.yaml'
const TRASH_PAYLOAD = 'payload'
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Manages the four writable skill roots without accepting arbitrary paths from callers.
 */
export class SkillAuthoringService {
  private roots: RootRecord[]
  private readonly rootById = new Map<string, RootRecord>()
  private readonly secret: Uint8Array
  private readonly maxFileBytes: number
  private readonly maxNameLength: number
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: SkillAuthoringOptions) {
    this.secret = typeof options.idSecret === 'string'
      ? Buffer.from(options.idSecret, 'utf8')
      : options.idSecret ?? randomBytes(32)
    this.maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 'maxFileBytes')
    this.maxNameLength = positiveInteger(options.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH, 'maxNameLength')

    const userRoots: Array<[SkillRootKind, string, string]> = [
      ['user-dsh', 'User DSH skills', join(resolve(options.dshHome), 'skills')],
      ['user-agents', 'User agent skills', join(resolve(options.agentsHome), 'skills')],
    ]
    const workspaceRoots = (options.workspaceRoots ?? []).map(root => resolve(root))
    const definitions: Array<[SkillRootKind, string, string]> = [
      ...userRoots,
      ...workspaceRoots.flatMap((root): Array<[SkillRootKind, string, string]> => [
        ['workspace-dsh', 'Workspace DSH skills', join(root, '.dsh', 'skills')],
        ['workspace-agents', 'Workspace agent skills', join(root, '.agents', 'skills')],
      ]),
    ]
    this.roots = definitions.map(([kind, label, path]) => ({ id: this.opaqueId('root', kind, path), kind, label, path }))
    this.reindex()
  }

  /**
   * Replace the scanned project roots (the live session workspaces). User roots
   * stay untouched; callers swap this set when sessions start or end.
   * @param workspaceRoots - canonical project directories to manage.
   */
  setWorkspaceRoots(workspaceRoots: readonly string[]): void {
    const userRoots = this.roots.filter(root => root.kind === 'user-dsh' || root.kind === 'user-agents')
    const workspace = workspaceRoots.map(root => resolve(root)).flatMap((root): Array<[SkillRootKind, string, string]> => [
      ['workspace-dsh', 'Workspace DSH skills', join(root, '.dsh', 'skills')],
      ['workspace-agents', 'Workspace agent skills', join(root, '.agents', 'skills')],
    ])
    this.roots = [
      ...userRoots,
      ...workspace.map(([kind, label, path]) => ({ id: this.opaqueId('root', kind, path), kind, label, path })),
    ]
    this.reindex()
  }

  private reindex(): void {
    this.rootById.clear()
    for (const root of this.roots) this.rootById.set(root.id, root)
  }

  /** @returns Path-free views of all configured roots. */
  async listRoots(): Promise<SkillRootView[]> {
    return await Promise.all(this.roots.map(async root => {
      const state = await rootState(root.path)
      return { id: root.id, kind: root.kind, label: root.label, ...state }
    }))
  }

  /** @returns Every top-level bundle and flat Markdown candidate, including malformed candidates with diagnostics. */
  async listCandidates(): Promise<SkillCandidateView[]> {
    const result: SkillCandidateView[] = []
    for (const root of this.roots) {
      const writable = (await rootState(root.path)).writable
      for (const candidate of await this.scanRoot(root)) {
        result.push(await this.candidateView(candidate, writable))
      }
    }
    return result
  }

  /** @param candidateId Opaque ID returned by listCandidates. @returns Parsed editable draft and CAS version. */
  async readCandidate(candidateId: string): Promise<SkillCandidateDraftView> {
    const candidate = await this.resolveCandidate(candidateId)
    await this.assertExistingCandidateContained(candidate)
    const raw = await readBoundedFile(candidate.filePath, this.maxFileBytes)
    const parsed = parseDraft(raw, this.maxNameLength)
    const view = await this.candidateView(candidate, await canWrite(candidate.filePath))
    return {
      candidate: view,
      draft: parsed.draft,
      version: versionOf(raw),
      diagnostics: view.diagnostics,
    }
  }

  /** @param draft Structured skill document. @returns Validation diagnostics; an empty array means valid. */
  validateDraft(draft: SkillDraft): SkillDiagnosticView[] {
    const diagnostics: SkillDiagnosticView[] = []
    validateName(draft.name, this.maxNameLength, diagnostics)
    if (typeof draft.description !== 'string' || draft.description.trim().length === 0) {
      diagnostics.push({ code: 'DESCRIPTION_REQUIRED', message: 'Description must be a non-empty string.' })
    }
    if (typeof draft.body !== 'string') diagnostics.push({ code: 'BODY_INVALID', message: 'Body must be a string.' })
    if (draft.whenToUse !== undefined && typeof draft.whenToUse !== 'string') {
      diagnostics.push({ code: 'WHEN_TO_USE_INVALID', message: 'whenToUse must be a string.' })
    }
    for (const [key, value] of Object.entries(draft.invocation ?? {})) {
      if ((key === 'modelInvocable' || key === 'userInvocable') && typeof value !== 'boolean') {
        diagnostics.push({ code: 'INVOCATION_INVALID', message: `${key} must be boolean.` })
      }
    }
    if (draft.metadata !== undefined && !isPlainRecord(draft.metadata)) {
      diagnostics.push({ code: 'METADATA_INVALID', message: 'metadata must be a YAML mapping.' })
    }
    if (draft.frontmatter !== undefined && !isPlainRecord(draft.frontmatter)) {
      diagnostics.push({ code: 'FRONTMATTER_INVALID', message: 'frontmatter must be a YAML mapping.' })
    }
    if (diagnostics.length === 0) {
      try {
        const text = serializeDraft(draft)
        if (Buffer.byteLength(text, 'utf8') > this.maxFileBytes) {
          diagnostics.push({ code: 'FILE_TOO_LARGE', message: `Skill file exceeds ${this.maxFileBytes} bytes.` })
        }
      } catch (error) {
        diagnostics.push({ code: 'YAML_INVALID', message: `Draft cannot be encoded as YAML: ${safeError(error)}` })
      }
    }
    return diagnostics
  }

  /** Creates a bundle or flat skill using an atomic same-directory rename. */
  async create(rootId: string, draft: SkillDraft, layout: SkillLayout = 'bundle'): Promise<SkillCandidateDraftView> {
    return await this.exclusive(async () => {
      const root = this.requireRoot(rootId)
      this.assertValidDraft(draft)
      assertLayout(layout)
      await ensureRoot(root.path)
      const rootCanonical = await realpath(root.path)
      const entryName = layout === 'bundle' ? draft.name : `${draft.name}.md`
      const entryPath = join(root.path, entryName)
      const filePath = layout === 'bundle' ? join(entryPath, 'SKILL.md') : entryPath
      await assertMissing(entryPath)
      if (layout === 'bundle') await mkdir(entryPath)
      try {
        await assertCanonicalParent(rootCanonical, filePath)
        await atomicWriteNew(filePath, serializeDraft(draft))
      } catch (error) {
        if (layout === 'bundle') await rm(entryPath, { recursive: true, force: true })
        throw normalizeFsError(error)
      }
      return await this.readCandidate(this.candidateId(root, layout, entryName))
    })
  }

  /** Replaces a candidate if its current content matches expectedVersion. */
  async update(candidateId: string, expectedVersion: string, draft: SkillDraft): Promise<SkillCandidateDraftView> {
    return await this.exclusive(async () => {
      const candidate = await this.resolveCandidate(candidateId)
      this.assertValidDraft(draft)
      if (draft.name !== candidate.skillName) {
        throw new SkillAuthoringError('INVALID_INPUT', 'Renaming during update is not supported; create or copy the skill instead.')
      }
      await this.assertExistingCandidateContained(candidate)
      const current = await readBoundedFile(candidate.filePath, this.maxFileBytes)
      if (versionOf(current) !== expectedVersion) throw new SkillAuthoringError('CONFLICT', 'The skill changed after it was read.')
      const next = serializeDraft(draft)
      await atomicReplaceCas(candidate.filePath, next, expectedVersion, this.maxFileBytes)
      return await this.readCandidate(candidate.id)
    })
  }

  /** Moves a candidate into its root's manager-owned trash after a CAS check. */
  async trash(candidateId: string, expectedVersion: string): Promise<TrashedSkillView> {
    return await this.exclusive(async () => {
      const candidate = await this.resolveCandidate(candidateId)
      await this.assertExistingCandidateContained(candidate)
      const current = await readBoundedFile(candidate.filePath, this.maxFileBytes)
      if (versionOf(current) !== expectedVersion) throw new SkillAuthoringError('CONFLICT', 'The skill changed after it was read.')
      const rootCanonical = await realpath(candidate.root.path)
      const trashRoot = join(candidate.root.path, TRASH_DIRECTORY)
      await mkdir(trashRoot, { recursive: true })
      await assertCanonicalPath(rootCanonical, trashRoot)
      const id = randomUUID()
      const container = join(trashRoot, id)
      await mkdir(container)
      const metadata: TrashMetadata = {
        version: 1,
        id,
        rootKind: candidate.root.kind,
        entryName: candidate.entryName,
        name: candidate.skillName,
        layout: candidate.layout,
        deletedAt: new Date().toISOString(),
      }
      try {
        await atomicWriteNew(join(container, TRASH_METADATA), stringifyYaml(metadata))
        await rename(candidate.entryPath, join(container, TRASH_PAYLOAD))
      } catch (error) {
        await rm(container, { recursive: true, force: true })
        throw normalizeFsError(error)
      }
      return { id, name: metadata.name, rootId: candidate.root.id, layout: metadata.layout, deletedAt: metadata.deletedAt }
    })
  }

  /** Restores a trashed entry when its original top-level name is still free. */
  async restore(trashId: string): Promise<SkillCandidateDraftView> {
    return await this.exclusive(async () => {
      const { root, container, metadata } = await this.resolveTrash(trashId)
      const target = join(root.path, metadata.entryName)
      await assertMissing(target)
      const rootCanonical = await realpath(root.path)
      await assertCanonicalPath(rootCanonical, container)
      const payload = join(container, TRASH_PAYLOAD)
      await assertSafeStoredPayload(payload, metadata.layout)
      await rename(payload, target)
      try {
        await unlink(join(container, TRASH_METADATA))
        await rm(container)
      } catch {
        // The restored skill is committed; stale trash bookkeeping can be removed by permanent deletion later.
      }
      return await this.readCandidate(this.candidateId(root, metadata.layout, metadata.entryName))
    })
  }

  /** Permanently removes one opaque trash entry. */
  async deletePermanently(trashId: string): Promise<void> {
    await this.exclusive(async () => {
      const { root, container } = await this.resolveTrash(trashId)
      await assertCanonicalPath(await realpath(root.path), container)
      await rm(container, { recursive: true, force: false })
    })
  }

  /** Copies one candidate into a writable root under a new skill name. */
  async copy(candidateId: string, rootId: string, newName: string): Promise<SkillCandidateDraftView> {
    if (!NAME_PATTERN.test(newName) || newName.length > this.maxNameLength || RESERVED_WINDOWS_NAMES.test(newName)) {
      throw new SkillAuthoringError('INVALID_INPUT', `Copy name must match ${NAME_PATTERN} and contain at most ${this.maxNameLength} characters.`)
    }
    const candidate = await this.resolveCandidate(candidateId)
    const source = await this.readCandidate(candidateId)
    const targetRoot = this.requireRoot(rootId)
    if (!(await rootState(targetRoot.path)).writable) {
      throw new SkillAuthoringError('READ_ONLY', 'The selected skill root is not writable.')
    }
    return await this.create(rootId, { ...source.draft, name: newName }, candidate.layout)
  }

  /** @returns Every recoverable trash entry across the writable roots. */
  async listTrash(): Promise<TrashedSkillView[]> {
    const views: TrashedSkillView[] = []
    for (const root of this.roots) {
      const trashRoot = join(root.path, TRASH_DIRECTORY)
      let names: string[]
      try {
        names = (await readdir(trashRoot)).filter(name => /^[0-9a-f-]{36}$/i.test(name))
      } catch (error) {
        if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) continue
        throw normalizeFsError(error)
      }
      for (const id of names.sort()) {
        try {
          const metadata = await this.readTrashMetadata(root, id)
          if (metadata !== undefined) {
            views.push({
              id,
              name: metadata.name,
              rootId: root.id,
              layout: metadata.layout,
              deletedAt: metadata.deletedAt,
            })
          }
        } catch (error) {
          if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) continue
          throw normalizeFsError(error)
        }
      }
    }
    return views
  }

  private async scanRoot(root: RootRecord): Promise<CandidateRecord[]> {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return []
      throw normalizeFsError(error)
    }
    const candidates: CandidateRecord[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === TRASH_DIRECTORY || entry.name.startsWith('.')) continue
      const entryPath = join(root.path, entry.name)
      if (entry.isDirectory()) {
        const filePath = join(entryPath, 'SKILL.md')
        if (await isRegularFileNoLinks(filePath, entryPath, root.path)) {
          candidates.push(this.makeCandidate(root, 'bundle', entry.name, entryPath, filePath))
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        candidates.push(this.makeCandidate(root, 'flat', entry.name, entryPath, entryPath))
      }
      // Top-level symbolic links and junction-like reparse points are never candidates.
    }
    return candidates
  }

  private makeCandidate(root: RootRecord, layout: SkillLayout, entryName: string, entryPath: string, filePath: string): CandidateRecord {
    const skillName = layout === 'bundle' ? entryName : entryName.slice(0, -3)
    return { id: this.candidateId(root, layout, entryName), root, entryName, skillName, layout, entryPath, filePath }
  }

  private async candidateView(candidate: CandidateRecord, writable: boolean): Promise<SkillCandidateView> {
    let raw: string | undefined
    let parsed: ParsedDraft | undefined
    const diagnostics: SkillDiagnosticView[] = []
    try {
      await this.assertExistingCandidateContained(candidate)
      raw = await readBoundedFile(candidate.filePath, this.maxFileBytes)
      parsed = parseDraft(raw, this.maxNameLength)
      diagnostics.push(...parsed.diagnostics)
    } catch (error) {
      const normalized = normalizeFsError(error)
      diagnostics.push({ code: normalized.code, message: normalized.message })
    }
    const draft = parsed?.draft
    const nameMatchesPath = draft === undefined || draft.name === candidate.skillName
    return {
      id: candidate.id,
      name: draft?.name ?? candidate.skillName,
      description: draft?.description ?? '',
      ...(draft?.whenToUse === undefined ? {} : { whenToUse: draft.whenToUse }),
      source: candidate.root.kind,
      provider: 'filesystem',
      rootId: candidate.root.id,
      layout: candidate.layout,
      editable: writable,
      deletable: writable,
      invocation: {
        modelInvocable: draft?.invocation?.modelInvocable !== false,
        userInvocable: draft?.invocation?.userInvocable !== false,
      },
      ...(raw === undefined ? {} : { version: versionOf(raw) }),
      diagnostics: nameMatchesPath
        ? diagnostics
        : [...diagnostics, { code: 'NAME_PATH_MISMATCH', message: 'Frontmatter name does not match the top-level entry name.' }],
    }
  }

  private async resolveCandidate(id: string): Promise<CandidateRecord> {
    for (const root of this.roots) {
      const match = (await this.scanRoot(root)).find(candidate => candidate.id === id)
      if (match !== undefined) return match
    }
    throw new SkillAuthoringError('NOT_FOUND', 'Skill candidate not found.')
  }

  private async assertExistingCandidateContained(candidate: CandidateRecord): Promise<void> {
    const rootCanonical = await canonicalDirectory(candidate.root.path)
    const entryInfo = await lstat(candidate.entryPath)
    if (entryInfo.isSymbolicLink()) throw containmentError()
    if (candidate.layout === 'bundle' && !entryInfo.isDirectory()) throw containmentError()
    if (candidate.layout === 'flat' && !entryInfo.isFile()) throw containmentError()
    const fileInfo = await lstat(candidate.filePath)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw containmentError()
    await assertCanonicalPath(rootCanonical, candidate.entryPath)
    await assertCanonicalPath(rootCanonical, candidate.filePath)
  }

  private assertValidDraft(draft: SkillDraft): void {
    const diagnostics = this.validateDraft(draft)
    if (diagnostics.length > 0) throw new SkillAuthoringError('INVALID_INPUT', diagnostics.map(item => item.message).join(' '))
  }

  private requireRoot(id: string): RootRecord {
    const root = this.rootById.get(id)
    if (root === undefined) throw new SkillAuthoringError('NOT_FOUND', 'Skill root not found.')
    return root
  }

  private candidateId(root: RootRecord, layout: SkillLayout, entryName: string): string {
    return this.opaqueId('candidate', root.id, layout, entryName)
  }

  private opaqueId(...parts: string[]): string {
    return createHmac('sha256', this.secret).update(parts.join('\0')).digest('base64url')
  }

  private async resolveTrash(id: string): Promise<{ root: RootRecord; container: string; metadata: TrashMetadata }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SkillAuthoringError('NOT_FOUND', 'Trash entry not found.')
    for (const root of this.roots) {
      try {
        const metadata = await this.readTrashMetadata(root, id)
        if (metadata !== undefined) {
          return { root, container: join(root.path, TRASH_DIRECTORY, id), metadata }
        }
      } catch (error) {
        if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) continue
        throw normalizeFsError(error)
      }
    }
    throw new SkillAuthoringError('NOT_FOUND', 'Trash entry not found.')
  }

  /** Read and validate one trash entry's metadata under a root; `undefined` means no such entry. */
  private async readTrashMetadata(root: RootRecord, id: string): Promise<TrashMetadata | undefined> {
    const container = join(root.path, TRASH_DIRECTORY, id)
    const rootCanonical = await canonicalDirectory(root.path)
    await assertCanonicalPath(rootCanonical, container)
    const raw = await readBoundedFile(join(container, TRASH_METADATA), 16 * 1024)
    const value = parseYaml(raw) as unknown
    if (!isTrashMetadata(value, id, root.kind, this.maxNameLength)) {
      throw new SkillAuthoringError('CONTAINMENT_REFUSED', 'Trash metadata is invalid.')
    }
    return value
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>(resolveRelease => { release = resolveRelease })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function parseDraft(raw: string, maxNameLength: number): ParsedDraft {
  const diagnostics: SkillDiagnosticView[] = []
  const split = splitFrontmatter(raw)
  if (split === undefined) {
    return { draft: { name: '', description: '', body: raw }, diagnostics: [{ code: 'FRONTMATTER_MISSING', message: 'Skill file must begin with YAML frontmatter.' }] }
  }
  let value: unknown
  try {
    value = parseYaml(split.yaml)
  } catch (error) {
    return { draft: { name: '', description: '', body: split.body }, diagnostics: [{ code: 'YAML_INVALID', message: `Invalid YAML frontmatter: ${safeError(error)}` }] }
  }
  if (!isPlainRecord(value)) {
    return { draft: { name: '', description: '', body: split.body }, diagnostics: [{ code: 'FRONTMATTER_INVALID', message: 'YAML frontmatter must be a mapping.' }] }
  }
  const name = typeof value.name === 'string' ? value.name : ''
  const description = typeof value.description === 'string' ? value.description : ''
  validateName(name, maxNameLength, diagnostics)
  if (description.trim().length === 0) diagnostics.push({ code: 'DESCRIPTION_REQUIRED', message: 'Frontmatter requires a non-empty description.' })
  const invocation: SkillInvocationDraft = { modelInvocable: true, userInvocable: true }
  try {
    invocation.modelInvocable = parseBoolean(value['disable-model-invocation'], false) !== true
    invocation.userInvocable = parseBoolean(value['user-invocable'], true) !== false
  } catch (error) {
    diagnostics.push({ code: 'INVOCATION_INVALID', message: safeError(error) })
  }
  const reserved = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable', 'metadata'])
  const frontmatter = Object.fromEntries(Object.entries(value).filter(([key]) => !reserved.has(key)))
  const metadata = isPlainRecord(value.metadata) ? value.metadata : undefined
  if (value.metadata !== undefined && metadata === undefined) diagnostics.push({ code: 'METADATA_INVALID', message: 'metadata must be a YAML mapping.' })
  return {
    draft: {
      name,
      description,
      ...(typeof value.whenToUse === 'string' ? { whenToUse: value.whenToUse } : {}),
      invocation,
      ...(metadata === undefined ? {} : { metadata }),
      body: split.body,
      ...(Object.keys(frontmatter).length === 0 ? {} : { frontmatter }),
    },
    diagnostics,
  }
}

function serializeDraft(draft: SkillDraft): string {
  const data: Record<string, unknown> = { ...(draft.frontmatter ?? {}) }
  data.name = draft.name
  data.description = draft.description
  if (draft.whenToUse !== undefined && draft.whenToUse.length > 0) data.whenToUse = draft.whenToUse
  else delete data.whenToUse
  const modelInvocable = draft.invocation?.modelInvocable ?? true
  const userInvocable = draft.invocation?.userInvocable ?? true
  if (!modelInvocable) data['disable-model-invocation'] = true
  else delete data['disable-model-invocation']
  if (!userInvocable) data['user-invocable'] = false
  else delete data['user-invocable']
  if (draft.metadata !== undefined) data.metadata = draft.metadata
  else delete data.metadata
  const yaml = stringifyYaml(data).trimEnd()
  return `---\n${yaml}\n---\n${draft.body}`
}

function splitFrontmatter(raw: string): { yaml: string; body: string } | undefined {
  const firstEnd = raw.indexOf('\n')
  if (firstEnd < 0 || raw.slice(0, firstEnd).replace(/\r$/, '') !== '---') return undefined
  let start = firstEnd + 1
  while (start <= raw.length) {
    const end = raw.indexOf('\n', start)
    const lineEnd = end < 0 ? raw.length : end
    if (raw.slice(start, lineEnd).replace(/\r$/, '') === '---') {
      return { yaml: raw.slice(firstEnd + 1, start), body: end < 0 ? '' : raw.slice(end + 1) }
    }
    if (end < 0) return undefined
    start = end + 1
  }
  return undefined
}

function validateName(name: string, maxLength: number, diagnostics: SkillDiagnosticView[]): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength || !NAME_PATTERN.test(name) || RESERVED_WINDOWS_NAMES.test(name)) {
    diagnostics.push({ code: 'NAME_INVALID', message: `Name must match ${NAME_PATTERN} and contain at most ${maxLength} characters.` })
  }
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new TypeError('Invocation frontmatter values must be boolean.')
}

async function rootState(path: string): Promise<{ writable: boolean; available: boolean }> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return { writable: false, available: false }
    return { writable: await canWrite(path), available: true }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) return { writable: false, available: false }
    return { writable: await canWriteNearestAncestor(path), available: false }
  }
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

async function canWriteNearestAncestor(path: string): Promise<boolean> {
  let current = path
  while (true) {
    try {
      return (await stat(current)).isDirectory() && await canWrite(current)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) return false
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

async function ensureRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw containmentError()
}

async function canonicalDirectory(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw containmentError()
  return await realpath(path)
}

async function assertCanonicalPath(rootCanonical: string, path: string): Promise<void> {
  const canonical = await realpath(path)
  if (!isContained(rootCanonical, canonical)) throw containmentError()
}

async function assertCanonicalParent(rootCanonical: string, path: string): Promise<void> {
  const parent = dirname(path)
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink()) throw containmentError()
  await assertCanonicalPath(rootCanonical, parent)
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function isRegularFileNoLinks(filePath: string, entryPath: string, rootPath: string): Promise<boolean> {
  try {
    const rootCanonical = await canonicalDirectory(rootPath)
    const entry = await lstat(entryPath)
    const file = await lstat(filePath)
    if (!entry.isDirectory() || entry.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) return false
    await assertCanonicalPath(rootCanonical, entryPath)
    await assertCanonicalPath(rootCanonical, filePath)
    return true
  } catch {
    return false
  }
}

async function assertSafeStoredPayload(payload: string, layout: SkillLayout): Promise<void> {
  const info = await lstat(payload)
  if (info.isSymbolicLink()) throw containmentError()
  if (layout === 'flat' && !info.isFile()) throw containmentError()
  if (layout === 'bundle' && !info.isDirectory()) throw containmentError()
  const skillFile = layout === 'bundle' ? join(payload, 'SKILL.md') : payload
  const skillInfo = await lstat(skillFile)
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink()) throw containmentError()
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new SkillAuthoringError('NOT_FOUND', 'Skill file not found.')
    if (info.size > maxBytes) throw new SkillAuthoringError('TOO_LARGE', `Skill file exceeds ${maxBytes} bytes.`)
    const data = await handle.readFile()
    if (data.byteLength > maxBytes) throw new SkillAuthoringError('TOO_LARGE', `Skill file exceeds ${maxBytes} bytes.`)
    return data.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function atomicWriteNew(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function atomicReplaceCas(path: string, text: string, expectedVersion: string, maxBytes: number): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (versionOf(await readBoundedFile(path, maxBytes)) !== expectedVersion) {
      throw new SkillAuthoringError('CONFLICT', 'The skill changed while the update was being committed.')
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  throw new SkillAuthoringError('CONFLICT', 'A skill with this name already exists in the selected root.')
}

function versionOf(raw: string): string {
  return createHmac('sha256', 'dsh-skill-manager-version-v1').update(raw).digest('base64url')
}

function isTrashMetadata(value: unknown, id: string, rootKind: SkillRootKind, maxNameLength: number): value is TrashMetadata {
  if (!isPlainRecord(value)) return false
  const diagnostics: SkillDiagnosticView[] = []
  if (typeof value.name === 'string') validateName(value.name, maxNameLength, diagnostics)
  else diagnostics.push({ code: 'NAME_INVALID', message: '' })
  const layout = value.layout
  const expectedEntry = layout === 'bundle' ? value.name : `${String(value.name)}.md`
  return value.version === 1
    && value.id === id
    && value.rootKind === rootKind
    && (layout === 'bundle' || layout === 'flat')
    && value.entryName === expectedEntry
    && typeof value.deletedAt === 'string'
    && diagnostics.length === 0
}

function assertLayout(layout: string): asserts layout is SkillLayout {
  if (layout !== 'bundle' && layout !== 'flat') throw new SkillAuthoringError('INVALID_INPUT', 'Layout must be bundle or flat.')
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer.`)
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containmentError(): SkillAuthoringError {
  return new SkillAuthoringError('CONTAINMENT_REFUSED', 'The skill path is not a canonical child of its managed root.')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeFsError(error: unknown): SkillAuthoringError {
  if (error instanceof SkillAuthoringError) return error
  if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return new SkillAuthoringError('NOT_FOUND', 'Managed skill entry not found.')
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM') || hasCode(error, 'EROFS')) return new SkillAuthoringError('READ_ONLY', 'The managed skill root is not writable.')
  if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY')) return new SkillAuthoringError('CONFLICT', 'The destination already exists.')
  return new SkillAuthoringError('UNAVAILABLE', `Filesystem operation failed: ${safeError(error)}`)
}
