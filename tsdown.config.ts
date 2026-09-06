/**
 * Standalone tsdown config for dsh-skill-manager.
 *
 * Emits two artifacts into lib/:
 *  - lib/index.js — the host-half ESM bundle (Skill Manager host plugin),
 *    resolved by the cordis Loader on the host.
 *  - lib/client.js — the browser CJS closure-factory bundle: calls
 *    window.__ModuleLoader__.load({ id, factory }) and resolves externals
 *    (react, @deepseek-ai/*) through the injected require — the loader module
 *    table. This is what DSH's client-modules serves at
 *    /plugins/<id>/client.js, so the Settings page installs without a rebuild.
 *
 * The stamped id is read from package.json so the bundle id always matches the
 * package name (the module-table key). Keep package.json `name` and
 * cordis.patch.yml's row `name` in sync.
 */

import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }
const PKG_NAME = pkg.name

const nodeHalf: UserConfig = {
  name: PKG_NAME,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  clean: false,
  fixedExtension: false,
  // Host-only runtime packages and installed libraries resolve from
  // node_modules at run time; the bundle keeps relative modules inlined.
  deps: { neverBundle: [/^@deepseek-ai\//, 'yaml'] },
}

const clientHalf: UserConfig = {
  name: `${PKG_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react', /^@deepseek-ai\//] },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, clientHalf]
