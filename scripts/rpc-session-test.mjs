/**
 * RPC-driven live-agent enforcement test against a smoke web profile.
 * Snapshots address the exact created session so the preset-mounted rows and
 * the overlay engine are observed on that Agent's scope.
 *
 * Usage: node scripts/rpc-session-test.mjs <origin> <token>
 * The session workspace defaults to process.env.SMOKE_CWD or the repository
 * root when SMOKE_CWD is unset.
 */

const [origin, token] = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sessionCwd = process.env.SMOKE_CWD ?? process.cwd()

async function withCookie() {
  const response = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  if (!cookie.includes('=')) throw new Error(`no auth cookie: ${setCookie}`)
  return cookie
}

async function rpc(cookie, method, payload) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `smoke-${Date.now()}`, method, payload }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`)
  if (body.type !== 'server-response') throw new Error(`unexpected envelope: ${JSON.stringify(body).slice(0, 300)}`)
  const result = body.result
  if (result?.ok !== true) throw new Error(`rpc failure: ${JSON.stringify(result?.error ?? result).slice(0, 800)}`)
  return result.value
}

const snapshotFor = (cookie, sessionId) =>
  rpc(cookie, 'skillManager/snapshot', { args: { request: sessionId === undefined ? {} : { scope: 'session', id: sessionId } } })

const cookie = await withCookie()
const report = {}

// 1. Create a real session on preset `standard` and start it with one prompt.
const created = await rpc(cookie, 'session/create', {
  args: { request: { cwd: sessionCwd, agentPreset: 'standard' } },
})
const sessionId = created.sessionId
report.created = created
console.log('session created:', JSON.stringify(created))

const prompt = await rpc(cookie, 'session/prompt', {
  args: {
    request: {
      requestId: `smoke-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly: OK' }],
      clientTimeZone: 'UTC',
    },
  },
})
report.prompt = prompt
console.log('prompt accepted:', JSON.stringify(prompt))

// 2. Wait until the preset rows mount and the neutral catalog lists skills.
let live = null
for (let attempt = 0; attempt < 90; attempt += 1) {
  await sleep(2000)
  live = await snapshotFor(cookie, sessionId)
  const names = (live?.effective ?? []).map(row => row.name)
  if (names.length > 0) {
    console.log(`catalog visible after ${(attempt + 1) * 2}s: ${names.join(', ')}`)
    break
  }
}
report.liveContext = live?.context
report.liveEffectiveBefore = (live?.effective ?? []).map(row => ({
  name: row.name,
  author: row.author,
  flags: row.effectiveInvocation ?? row.author,
}))
console.log('live before policy:', JSON.stringify(report.liveEffectiveBefore))

// 3. Apply a global allow-list: denies every unlisted skill.
const write = await rpc(cookie, 'skillManager/setLayer', {
  args: {
    request: {
      scope: 'global',
      key: null,
      mode: 'allow-list',
      states: {},
      expectedRevision: live?.revision ?? 0,
    },
  },
})
report.policyWrite = { revision: write.revision }
console.log('policy written:', JSON.stringify(report.policyWrite))

// 4. Wait until the engine tightens flags on the live Agent scope.
let after = null
let tightened = false
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1500)
  after = await snapshotFor(cookie, sessionId)
  tightened = (after?.effective ?? []).some(row =>
    row.effectiveInvocation !== undefined
    && row.effectiveInvocation.modelInvocable === false
    && row.effectiveInvocation.userInvocable === false)
  if (tightened) break
}
report.after = {
  context: after?.context,
  revision: after?.revision,
  effective: (after?.effective ?? []).map(row => ({
    name: row.name,
    author: row.author,
    effectiveInvocation: row.effectiveInvocation,
  })),
}
console.log('after policy:', JSON.stringify(report.after, null, 2))
console.log(`overlay tightened flags on live agent: ${tightened}`)
console.log('REPORT ' + JSON.stringify(report))
process.exit(tightened ? 0 : 1)
