import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const destination = resolve(
  root,
  process.argv[2] ?? 'apps/android/app/src/main/assets/licenses/native'
)
mkdirSync(destination, { recursive: true })
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
)
const entries = []
for (const crate of metadata.packages) {
  if (!crate.source && !/[/\\]vendor[/\\]/.test(crate.manifest_path)) continue
  const dir = dirname(crate.manifest_path),
    out = join(destination, crate.name + '-' + crate.version)
  mkdirSync(out, { recursive: true })
  for (const name of readdirSync(dir))
    if (/^(licen[cs]e|copying|notice)([._-]|$)/i.test(name) && existsSync(join(dir, name)))
      copyFileSync(join(dir, name), join(out, name))
  if (existsSync(join(dir, 'JUST-A-PLAYER.md')))
    copyFileSync(join(dir, 'JUST-A-PLAYER.md'), join(out, 'JUST-A-PLAYER.md'))
  entries.push({
    name: crate.name,
    version: crate.version,
    license: crate.license,
    repository: crate.repository,
    source:
      crate.source ?? 'https://github.com/B5-Software/just-a-player/tree/main/vendor/' + crate.name,
  })
}
for (const name of ['LICENSE', 'THIRD_PARTY.md'])
  copyFileSync(join(root, name), join(destination, name))
writeFileSync(join(destination, 'dependencies.json'), JSON.stringify(entries, null, 2))
console.log(`Prepared native dependency notices: ${entries.length}`)
