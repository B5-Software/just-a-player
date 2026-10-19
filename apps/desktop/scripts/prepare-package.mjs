import { createRequire } from 'node:module'
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const app = resolve(fileURLToPath(import.meta.url), '../..'),
  root = resolve(app, '../..')
const notices = join(app, 'build/notices')
mkdirSync(notices, { recursive: true })
for (const file of ['LICENSE', 'THIRD_PARTY.md'])
  copyFileSync(join(root, file), join(notices, file))
for (const file of ['LICENSE', 'COPYING.LESSER'])
  copyFileSync(join(root, 'crates/jap-decode/vendor/dst', file), join(notices, 'DST-' + file))
copyFileSync(
  join(root, 'crates/jap-decode/NCM-MIT-LICENSE.txt'),
  join(notices, 'NCM-MIT-LICENSE.txt')
)

// Bundle complete upstream license/notice files for the code used in the app.
const entries = [],
  seen = new Set()
function licenseFiles(folder, prefix) {
  mkdirSync(prefix, { recursive: true })
  const files = readdirSync(folder, { withFileTypes: true }).filter(
    (name) => name.isFile() && /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name.name)
  )
  for (const name of files) copyFileSync(join(folder, name.name), join(prefix, name.name))
  if (!files.length) {
    const readme = readdirSync(folder).find((name) => /^readme(\.|$)/i.test(name))
    if (readme) copyFileSync(join(folder, readme), join(prefix, readme))
  }
}
function visit(name, from) {
  try {
    const require = createRequire(from)
    let manifest
    try {
      manifest = require.resolve(name + '/package.json')
    } catch {
      let dir = dirname(require.resolve(name))
      while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
      manifest = join(dir, 'package.json')
    }
    const p = JSON.parse(readFileSync(manifest, 'utf8')),
      key = p.name + '@' + p.version
    if (seen.has(key)) return
    seen.add(key)
    const folder = join(notices, 'npm', p.name.replaceAll('/', '_') + '-' + p.version)
    licenseFiles(dirname(manifest), folder)
    entries.push({
      ecosystem: 'npm',
      name: p.name,
      version: p.version,
      license: p.license,
      repository: p.repository
    })
    for (const dependency of Object.keys(p.dependencies ?? {})) visit(dependency, manifest)
  } catch (error) {
    throw new Error('License collection failed for ' + name + ': ' + error.message)
  }
}
const packagePath = join(app, 'package.json'),
  p = JSON.parse(readFileSync(packagePath, 'utf8'))
for (const name of [
  ...Object.keys(p.dependencies),
  'react',
  'react-dom',
  'three',
  'zustand',
  'motion',
  '@phosphor-icons/react'
])
  visit(name, packagePath)
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
)
for (const crate of metadata.packages)
  if (crate.source) {
    licenseFiles(
      dirname(crate.manifest_path),
      join(notices, 'rust', crate.name + '-' + crate.version)
    )
    entries.push({
      ecosystem: 'cargo',
      name: crate.name,
      version: crate.version,
      license: crate.license,
      repository: crate.repository,
      source: crate.source
    })
  }
writeFileSync(join(notices, 'dependencies.json'), JSON.stringify(entries, null, 2) + '\n')
if (!existsSync(join(app, 'build/icon.png')))
  throw new Error('Missing application icon; run the screenshot/asset preparation script first.')
console.log('Prepared ' + entries.length + ' dependency notices for ' + p.version)
