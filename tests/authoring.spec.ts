// Authoring service tests: discovery, CAS writes, containment, and trash.
// Run with: npx vitest run tests/authoring.spec.ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillAuthoringError, SkillAuthoringService } from '../src/authoring.ts'

const draft = (name: string, description = 'Does things.') => ({
  name,
  description,
  body: '# Instructions\n\nBe helpful.',
})

describe('SkillAuthoringService', () => {
  let home: string
  let agents: string
  let workspace: string
  let service: SkillAuthoringService

  afterEach(async () => {
    for (const root of [home, agents, workspace]) {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  const makeService = async (workspaceRoot?: string) => {
    home = await mkdtemp(join(tmpdir(), 'dsh-sm-home-'))
    agents = await mkdtemp(join(tmpdir(), 'dsh-sm-agents-'))
    service = new SkillAuthoringService({
      dshHome: home,
      agentsHome: agents,
      ...(workspaceRoot === undefined ? {} : { workspaceRoots: [workspaceRoot] }),
    })
    return service
  }

  /** Resolve the opaque id of one managed root kind. */
  const rootIdOf = async (kind: string): Promise<string> => {
    const roots = await service.listRoots()
    const root = roots.find(candidate => candidate.kind === kind)
    if (root === undefined) throw new Error(`root ${kind} is missing`)
    return root.id
  }

  it('creates and reads a bundle skill with a CAS version', async () => {
    await makeService()
    const user = await rootIdOf('user-dsh')
    const created = await service.create(user, draft('alpha'), 'bundle')
    expect(created.draft.name).toBe('alpha')
    expect(created.version).toBeTruthy()
    expect(created.diagnostics).toEqual([])
    const read = await service.readCandidate(created.candidate.id)
    expect(read.draft.body).toContain('Be helpful')
    expect(read.candidate.layout).toBe('bundle')
    await expect(service.create(user, draft('alpha'), 'bundle')).rejects.toThrow(/already exists/)
  })

  it('rejects stale CAS updates with CONFLICT', async () => {
    await makeService()
    const user = await rootIdOf('user-dsh')
    const created = await service.create(user, draft('beta'), 'bundle')
    await expect(service.update(created.candidate.id, 'stale-version', draft('beta'))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const updated = await service.update(created.candidate.id, created.version, draft('beta'))
    expect(updated.draft.body).toContain('Be helpful')
  })

  it('lists flat and bundle candidates across user roots', async () => {
    await makeService()
    const userDsh = await rootIdOf('user-dsh')
    const userAgents = await rootIdOf('user-agents')
    await service.create(userDsh, draft('flat-one'), 'flat')
    await service.create(userAgents, draft('bundle-two'), 'bundle')
    const candidates = await service.listCandidates()
    expect(candidates.map(candidate => candidate.name).sort()).toEqual(['bundle-two', 'flat-one'])
    const flat = candidates.find(candidate => candidate.name === 'flat-one')
    expect(flat?.layout).toBe('flat')
    expect(flat?.source).toBe('user-dsh')
  })

  it('rejects names that cannot be file-system safe or kebab-case', async () => {
    await makeService()
    const user = await rootIdOf('user-dsh')
    await expect(service.create(user, draft('Con'), 'bundle')).rejects.toBeInstanceOf(SkillAuthoringError)
    await expect(service.create(user, draft('Bad_Name'), 'bundle')).rejects.toBeInstanceOf(SkillAuthoringError)
  })

  it('keeps workspace roots isolated and refreshable', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dsh-sm-ws-'))
    await makeService(workspace)
    const workspaceRoot = await rootIdOf('workspace-dsh')
    await service.create(workspaceRoot, draft('ws-skill'), 'bundle')
    expect((await service.listCandidates()).map(candidate => candidate.name)).toContain('ws-skill')
    service.setWorkspaceRoots([])
    expect((await service.listCandidates()).map(candidate => candidate.name)).not.toContain('ws-skill')
  })

  it('trashes, lists, restores, and permanently deletes', async () => {
    await makeService()
    const user = await rootIdOf('user-dsh')
    const created = await service.create(user, draft('recoverable'), 'bundle')
    const trashed = await service.trash(created.candidate.id, created.version)
    expect(trashed.name).toBe('recoverable')
    expect((await service.listCandidates()).some(candidate => candidate.name === 'recoverable')).toBe(false)
    const trash = await service.listTrash()
    expect(trash.map(entry => entry.name)).toContain('recoverable')
    const restored = await service.restore(trashed.id)
    expect(restored.draft.name).toBe('recoverable')
    const trashedAgain = await service.trash(restored.candidate.id, restored.version)
    await service.deletePermanently(trashedAgain.id)
    expect(await service.listTrash()).toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')('refuses to follow a top-level symlink out of the root', async () => {
    await makeService()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-sm-out-'))
    try {
      await mkdir(join(home), { recursive: true })
      await symlink(outside, join(home, 'skills'), 'dir')
      const roots = await service.listRoots()
      const userRoot = roots.find(root => root.kind === 'user-dsh')
      expect(userRoot?.available).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('detects edits made outside the manager', async () => {
    await makeService()
    const user = await rootIdOf('user-dsh')
    const created = await service.create(user, draft('external-edit'), 'bundle')
    const skillFile = join(home, 'skills', 'external-edit', 'SKILL.md')
    await writeFile(skillFile, '# Manual\n\nChanged.', 'utf8')
    await expect(service.update(created.candidate.id, created.version, draft('external-edit'))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})
