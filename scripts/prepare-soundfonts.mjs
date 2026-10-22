import fs from 'node:fs'
import { mkdir, copyFile, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, 'assets/soundfonts')
const archive = 'musescore-general-soundfont_0.2.1.orig.tar.xz'
const source = 'https://deb.debian.org/debian/pool/main/m/musescore-general-soundfont/' + archive
const sourceHash = '0e481d40ac7114d6aef5bdcf7d0246829b8f8873de02049896cd120d8490bcae'
const bank = 'MuseScore_General_HQ.sf2'
const bankHash = '985680908c60c082919abdb27708b36726567ddc200b2bb55a62471c37e4fa07'
if (process.env.JAP_BUNDLE_MIDI === '0') {
  // A cached HQ bank must never leak into an Android without-midi artifact.
  if (process.argv.includes('--android'))
    fs.rmSync(join(root, 'apps/android/app/src/main/assets/soundfonts', bank), { force: true })
  console.log('without-midi: no bundled sound bank; SF2 import remains available')
  process.exit(0)
}
async function hash(file) {
  const h = createHash('sha256')
  for await (const part of fs.createReadStream(file)) h.update(part)
  return h.digest('hex')
}
await mkdir(dir, { recursive: true })
if (!fs.existsSync(join(dir, bank)) || (await hash(join(dir, bank))) !== bankHash) {
  if (!fs.existsSync(join(dir, archive))) {
    console.log('Downloading lossless MuseScore General HQ 0.2.1 sound bank (build time only)…')
    const r = await fetch(source)
    if (!r.ok) throw Error(`SoundFont source HTTP ${r.status}`)
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(join(dir, archive + '.part')))
    await rename(join(dir, archive + '.part'), join(dir, archive))
  }
  if ((await hash(join(dir, archive))) !== sourceHash)
    throw Error('SoundFont source SHA-256 mismatch')
  await mkdir(join(dir, 'upstream'), { recursive: true })
  const r = spawnSync('tar', ['-xf', join(dir, archive), '-C', join(dir, 'upstream')], {
    stdio: 'inherit',
  })
  if (r.status !== 0) throw Error('SoundFont extraction failed')
  await copyFile(
    join(dir, 'upstream/musescore-general-soundfont-0.2.1.orig', bank),
    join(dir, bank)
  )
  if ((await hash(join(dir, bank))) !== bankHash) throw Error('SoundFont SHA-256 mismatch')
}
const docs = join(dir, 'documentation')
await mkdir(docs, { recursive: true })
const upstreamDocs = join(dir, 'upstream/musescore-general-soundfont-0.2.1.orig/documentation')
for (const file of [
  'MuseScore_General_HQ_License.md',
  'MuseScore_General_HQ_Readme.md',
  'MuseScore_General_HQ_Changelog.md',
  'MuseScore_General_HQ_Sample_Sources.csv',
]) {
  if (fs.existsSync(join(upstreamDocs, file)))
    await copyFile(join(upstreamDocs, file), join(docs, file))
  if (!fs.existsSync(join(docs, file))) throw Error('Missing SoundFont attribution: ' + file)
}
await copyFile(join(root, 'vendor/oxisynth/LICENSE'), join(docs, 'OxiSynth-LGPL-2.1.txt'))
fs.writeFileSync(
  join(docs, 'source.json'),
  JSON.stringify(
    {
      name: 'MuseScore General HQ',
      version: '0.2.1',
      source,
      sourceSha256: sourceHash,
      file: bank,
      sha256: bankHash,
      bytes: (await stat(join(dir, bank))).size,
      license: 'MIT',
      author: 'S. Christian Collins, Frank Wen, Michael Cowgill and contributors',
    },
    null,
    2
  )
)
if (process.argv.includes('--android')) {
  const assets = join(root, 'apps/android/app/src/main/assets')
  await mkdir(join(assets, 'soundfonts'), { recursive: true })
  await copyFile(join(dir, bank), join(assets, 'soundfonts', bank))
  for (const file of fs.readdirSync(docs))
    await copyFile(join(docs, file), join(assets, 'licenses', file))
}
console.log('Lossless MIDI HQ sound bank verified')
