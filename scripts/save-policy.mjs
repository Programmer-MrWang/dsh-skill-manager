/** Drives the Policies view: switch global mode to deny-list and save. */
const [pageUrl, cdpPort] = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(r => r.json())
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
const click = text => evaluate(`(() => {
  const candidates = [...document.querySelectorAll('button, [role="tab"], [tabindex], a')]
  const el = candidates.find(node => node.offsetParent !== null && node.textContent && node.textContent.trim().includes('${text}'))
  if (!el) return false
  el.click(); return true
})()`)

await send('Page.navigate', { url: pageUrl })
await sleep(7000)
if (await evaluate(`document.body.innerText.includes('内测声明')`)) {
  await click('继续')
  await sleep(1500)
}
await click('设置')
await sleep(1500)
await click('Skills')
await sleep(2000)
await click('策略')
await sleep(1500)

const changed = await evaluate(`(() => {
  const selects = [...document.querySelectorAll('.sm-select')]
  const modeSelect = selects.find(node => node.getAttribute('aria-label') === '默认模式')
  if (!modeSelect) return 'mode select not found'
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(modeSelect, 'deny-list')
  modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
  return 'set:' + modeSelect.value
})()`)
console.log('mode change:', changed)
await sleep(800)
const saved = await click('保存策略')
console.log('save clicked:', saved)
await sleep(2500)
const text = await evaluate(`document.body.innerText`)
console.log('saved notice shown:', text.includes('已保存。') || text.includes('Saved.'))
console.log('conflict/error shown:', text.includes('无法保存更改') || text.includes('Could not save'))
ws.close()
