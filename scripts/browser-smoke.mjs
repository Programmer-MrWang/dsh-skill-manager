/**
 * Headless Edge (CDP) smoke driver for the Skill Manager settings section.
 *
 * Usage: node scripts/browser-smoke.mjs <page-url> <cdp-http-port> <artifact-dir>
 */

const [pageUrl, cdpPort, artifactDir] = process.argv.slice(2)
if (!pageUrl || !cdpPort || !artifactDir) {
  console.error('usage: browser-smoke.mjs <page-url> <cdp-port> <artifact-dir>')
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Minimal CDP client over the global WebSocket. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('CDP socket error')))
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id)
        if (waiter) {
          this.pending.delete(message.id)
          message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
        }
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.events.push({ kind: 'console', type: message.params.type, text: message.params.args.map(a => a.value ?? a.description ?? '').join(' ') })
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.events.push({ kind: 'exception', text: message.params.exceptionDetails?.text ?? 'exception', description: message.params.exceptionDetails?.exception?.description ?? '' })
      } else if (message.method === 'Log.entryAdded') {
        this.events.push({ kind: 'log', level: message.params.entry.level, text: message.params.entry.text })
      }
    })
  }
  async send(method, params = {}) {
    await this.ready
    const id = this.nextId++
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`page evaluation failed: ${result.exceptionDetails.text}`)
    return result.result.value
  }
  close() {
    this.ws.close()
  }
}

/** Poll an in-page predicate until it passes or the timeout expires. */
async function waitFor(cdp, expression, timeoutMs = 30000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch { /* page may still be booting */ }
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

const clickText = texts => {
  const needles = Array.isArray(texts) ? texts : [texts]
  return `(() => {
  const candidates = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="button"], a, [tabindex]')]
  const el = candidates.find(node => node.offsetParent !== null && node.textContent && ${needles.map(text => `node.textContent.trim().includes(${JSON.stringify(text)})`).join(' || ')})
  if (!el) return false
  el.click()
  return true
})()`
}

/** Programmatic click used for in-page navigation (works under overlays). */
async function clickByText(cdp, texts) {
  return await cdp.evaluate(clickText(texts))
}

/** Real mouse click used to dismiss the topmost onboarding overlay. */
async function mouseClick(cdp, texts) {
  const needles = Array.isArray(texts) ? texts : [texts]
  const point = await cdp.evaluate(`(() => {
  const candidates = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="button"], a, [tabindex]')]
  const el = candidates.find(node => node.offsetParent !== null && node.textContent && ${needles.map(text => `node.textContent.trim().includes(${JSON.stringify(text)})`).join(' || ')})
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)
  if (point === null || point === undefined) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return true
}

const hasText = text => `document.body.innerText.includes(${JSON.stringify(text)})`

async function main() {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(response => response.json())
  const page = targets.find(target => target.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target available on the CDP port')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  await cdp.send('Page.navigate', { url: pageUrl })
  await sleep(3000)
  await waitFor(cdp, `document.readyState === 'complete'`, 30000, 'page load')
  await waitFor(cdp, `document.body && document.body.innerText.length > 50`, 40000, 'app shell render')
  await sleep(4000)

  const report = { steps: [] }
  const step = async (label, action) => {
    try {
      const value = await action()
      report.steps.push({ label, ok: true, value })
    } catch (error) {
      report.steps.push({ label, ok: false, error: error.message })
      throw error
    }
  }

  await step('dismiss onboarding', async () => {
    const hasOnboarding = await cdp.evaluate(`document.body.innerText.includes('继续') && document.body.innerText.includes('内测声明')`)
    if (!hasOnboarding) return false
    const clicked = await mouseClick(cdp, ['继续'])
    await sleep(1500)
    return clicked
  })

  await step('open Settings', async () => {
    const clicked = await clickByText(cdp, ['Settings', '设置'])
    if (!clicked) {
      const sample = await cdp.evaluate(`document.body.innerText.slice(0, 800)`)
      throw new Error(`Settings entry not found in the sidebar. body: ${JSON.stringify(sample)}`)
    }
    await sleep(1200)
    return await cdp.evaluate(`document.body.innerText.includes('Settings') || document.body.innerText.includes('设置')`)
  })

  await step('open Skills section', async () => {
    const clicked = await clickByText(cdp, ['Skills', '技能'])
    if (!clicked) throw new Error('Skills section entry not found')
    await sleep(2000)
    const sample = await cdp.evaluate(`document.body.innerText.slice(0, 1500)`)
    const marker = sample.includes('Effective catalog') || sample.includes('生效目录')
      || sample.includes('Managed skills') || sample.includes('可管理 Skills')
    if (!marker) throw new Error(`Skills section did not render. body: ${JSON.stringify(sample)}`)
    return { clicked, marker }
  })

  await step('Installed view shows catalog and managed skill', async () => {
    const text = await cdp.evaluate(`document.body.innerText`)
    return {
      hasEffective: text.includes('Effective catalog') || text.includes('生效目录'),
      hasManaged: text.includes('Managed skills on disk') || text.includes('可管理 Skills'),
      hasAlpha: text.includes('alpha'),
      hasNoErrorsBanner: !text.includes('Could not load skills.') && !text.includes('无法加载 Skills'),
    }
  })

  await step('open Policies view', async () => {
    const clicked = await clickByText(cdp, ['Policies', '策略'])
    if (!clicked) throw new Error('Policies tab not found')
    await waitFor(cdp, `document.body.innerText.includes('Policy scope') || document.body.innerText.includes('策略作用域') || document.body.innerText.includes('Default mode') || document.body.innerText.includes('默认模式')`, 15000, 'Policies view render')
    return true
  })

  await step('Policies view sanity', async () => {
    const text = await cdp.evaluate(`document.body.innerText`)
    return {
      hasScope: text.includes('Policy scope') || text.includes('策略作用域'),
      hasMode: text.includes('Default mode') || text.includes('默认模式'),
      hasAlphaRow: text.includes('alpha'),
    }
  })

  await step('screenshot', async () => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    fs.mkdirSync(artifactDir, { recursive: true })
    fs.writeFileSync(`${artifactDir}/settings-skills.png`, Buffer.from(shot.data, 'base64'))
    return `${artifactDir}/settings-skills.png`
  })

  const problems = cdp.events.filter(event => event.kind === 'exception' || (event.kind === 'log' && event.level === 'error'))
  report.consoleIssues = problems
  report.consoleSamples = cdp.events.slice(0, 20)
  console.log(JSON.stringify(report, null, 2))
  cdp.close()
  const fatal = problems.some(event => event.kind === 'exception' || event.text.includes('skill-manager') || event.text.includes('skillManager'))
  process.exit(fatal ? 1 : 0)
}

main().catch(error => {
  console.error(JSON.stringify({ fatal: error.message }, null, 2))
  process.exit(1)
})
