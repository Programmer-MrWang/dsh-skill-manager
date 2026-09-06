/**
 * In-process activation check for the Skill Manager host plugin.
 *
 * Boots a real Cordis context with the real Typert registry plus minimal
 * settings/skills stubs, applies lib/index.js exactly like the Loader would,
 * and reports whether the `skillManager` Service is available.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as manager from '../lib/index.js'

class StubSettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings')
    this.base = { policy: null }
    this.user = undefined
    this.watchers = []
    this.registerCalls = 0
  }
  register(_ns, _schema, options = {}) {
    this.registerCalls += 1
    this.base = { ...(options.base ?? {}) }
    const scope = this
    return {
      get: () => ({ ...scope.base, ...(scope.user ?? {}) }),
      watch: callback => {
        scope.watchers.push(callback)
        return () => {
          const index = scope.watchers.indexOf(callback)
          if (index >= 0) scope.watchers.splice(index, 1)
        }
      },
      update: async patch => {
        scope.user = { ...(scope.user ?? {}), ...patch }
        for (const watcher of [...scope.watchers]) watcher(scope.get())
      },
      replace: async section => {
        scope.user = section
        for (const watcher of [...scope.watchers]) watcher(scope.get())
      },
    }
  }
}

class StubSkills extends Service {
  constructor(ctx) {
    super(ctx, 'skills')
  }
  async list() {
    return []
  }
  async get() {
    return undefined
  }
  registerProvider() {
    return () => {}
  }
}

const ctx = new Context()
await ctx.plugin(TypertRegistry)
const settings = new StubSettings(ctx)
new StubSkills(ctx)

// Sanity: a trivial plugin providing a service must be visible at root.
class ProbeService extends Service {
  constructor(inner) {
    super(inner, 'probe')
    this.marker = true
  }
}
const probePlugin = (inner) => { new ProbeService(inner) }
await ctx.plugin(probePlugin, {})
console.log(`probe visible: ${ctx.get('probe')?.marker === true}`)

let activationError = null
try {
  // Mirror the Loader: the plugin function carries its name and inject list;
  // core Cordis waits for the injected services before running apply.
  const plugin = manager.apply
  Object.defineProperty(plugin, 'name', { value: 'skill-manager', configurable: true })
  plugin.inject = manager.inject
  await ctx.plugin(plugin, {})
  console.log('apply: ok')
} catch (error) {
  activationError = error
  console.log('apply: FAILED')
  console.log(error?.stack ?? String(error))
}
console.log(`settings.register calls: ${settings.registerCalls}`)

const service = ctx.get('skillManager')
console.log(`service available: ${service !== undefined}`)
if (service !== undefined) {
  const methods = ['snapshot', 'readDraft', 'validateDraft', 'create', 'update', 'copy', 'trash', 'restore', 'deletePermanently', 'setLayer']
  console.log(`methods present: ${methods.every(method => typeof service[method] === 'function')}`)
}
await ctx.dispose?.() ?? ctx.fiber?.dispose?.()
process.exit(activationError === null && ctx.get('skillManager') !== undefined ? 0 : 1)
