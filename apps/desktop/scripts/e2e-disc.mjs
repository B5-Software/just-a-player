import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { writeDiscFixtures } from '../../../scripts/fixtures/disc.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url)),
  dir = path.join(os.tmpdir(), 'jap-disc-qa')
const files = writeDiscFixtures(dir),
  checks = []
const invalidIso = path.join(dir, 'ordinary-data.iso')
fs.writeFileSync(invalidIso, Buffer.alloc(2048 * 32))
const app = await electron.launch({
  executablePath: electronPath,
  cwd,
  args: ['.', '--no-sandbox', ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'discs' },
})
try {
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => window.__jap?.usePlayer.getState().connected && window.__jap.useLibrary.getState().loaded
  )
  await page.evaluate(() => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings.getState().update({ autoScan: false, autoHideControls: false })
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  })
  const data = await page.evaluate(async (files) => {
    const j = window.__jap,
      id = j.useLibrary.getState().createList('Disc test')
    await j.addAudioPaths([files.iso, files.cue, files.bin], false, id)
    const items = j.useLibrary.getState().lists.find((l) => l.id === id).items
    const exists = await window.jap.pathsExist(items.map((t) => t.path))
    const metadata = []
    for (const item of items) metadata.push(await j.usePlayer.getState().probe(item.path))
    j.useLibrary.getState().dedupeList(id)
    return {
      items,
      exists,
      metadata,
      countAfterDedupe: j.useLibrary.getState().lists.find((l) => l.id === id).items.length,
    }
  }, files)
  assert.deepEqual(
    data.items.map((t) => t.title),
    ['SACD Track 1', 'SACD Track 2', 'CD First', 'CD Second']
  )
  assert.ok(data.exists.every(Boolean))
  assert.equal(data.countAfterDedupe, 4)
  assert.ok(data.metadata.every((t) => t.durationMs === 1000))
  checks.push('SACD + CD/CUE expand into four tagged tracks; CUE/BIN double selection deduplicates')
  const notifications = await page.evaluate(async (path) => {
    const j = window.__jap,
      id = j.useLibrary.getState().activeListId
    j.usePlayer.setState({ error: null })
    await j.addAudioPaths([path], false, id, true)
    await j.addAudioPaths([path], false, id, true)
    const background = j.usePlayer.getState().error
    await j.addAudioPaths([path], false, id, false)
    return { background, manual: j.usePlayer.getState().error }
  }, invalidIso)
  assert.equal(notifications.background, null)
  assert.match(notifications.manual, /CUE|CD-DA/)
  checks.push(
    'Repeated background scans skip unsupported data ISO silently; manual import explains the missing CUE'
  )
  const samples = await page.evaluate(
    async (paths) => {
      const out = []
      for (const path of paths) {
        const job = await window.__jap.engine.offline('open', {
          path,
          writeAudio: true,
          startMs: 900,
        })
        await window.__jap.engine.offline('frame', { timeMs: 1000 })
        await window.__jap.engine.offline('close')
        out.push({ data: Array.from(await window.jap.readFile(job.audioPath)) })
      }
      return out
    },
    data.items.slice(2).map((t) => t.path)
  )
  for (let i = 0; i < samples.length; i++) {
    const bytes = Buffer.from(samples[i].data),
      at = bytes.indexOf('data') + 8
    assert.equal(bytes.readInt32LE(at), (i === 0 ? 1024 : -2048) * 65536)
    assert.equal(bytes.length - at, 4410 * 2 * 4)
  }
  checks.push('Offline export starts inside the selected CD track and stops at its exact boundary')
  // Verify the actual user file only locally; CI uses the original fixtures above.
  if (process.env.JAP_SACD_QA_PATH) {
    const tracks = await page.evaluate(
      async (path) => (await window.__jap.engine.query({ type: 'discTracks', path })).tracks,
      process.env.JAP_SACD_QA_PATH
    )
    assert.equal(tracks.length, 20)
    checks.push('Local Teresa Teng SACD: 20 independently addressed tracks')
  }
  fs.mkdirSync(path.join(cwd, 'test-results'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'test-results/discs.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ checks }, null, 2))
} finally {
  await app.close()
}
