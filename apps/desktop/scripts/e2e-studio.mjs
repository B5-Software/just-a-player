import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { answerNextFileDialog } from './e2e-dialog-helper.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
import { wave } from '../../../scripts/fixtures/pcm.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url)),
  out = path.join(cwd, 'test-results/studio')
fs.mkdirSync(out, { recursive: true })
const vuTone=path.join(out,'Original VU Tone.wav'),vuPcm=wave()
for(let at=44;at<vuPcm.length;at+=4){vuPcm.writeInt16LE(Math.round(vuPcm.readInt16LE(at)*.55),at);vuPcm.writeInt16LE(Math.round(vuPcm.readInt16LE(at+2)*.38),at+2)}
fs.writeFileSync(vuTone,vuPcm)
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.', ...graphicsArgs],
  cwd,
  env: { ...process.env, JAP_E2E: 'studio' },
})
const page = await app.firstWindow(),
  errors = [],
  checks = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' && /THREE.WebGLProgram|shader error|VALIDATE_STATUS/i.test(m.text()))
    errors.push(m.text())
})
try {
  await page.waitForFunction(() => window.__japViz?.frameVersion > 0)
  await page.evaluate(() => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings.getState().update({
      themeMode: 'dark',
      legacyVisuals: false,
      disabledVisuals: [],
      visualPlugins: [],
      autoAccent: false,
      autoBackdrop: false,
      accent: '#8b9fd9',
      autoHideControls: false,
      renderFps: 30,
      lyricsVisible: false,
    })
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setZoom(1)
    j.useViz.getState().setOffset({ x: 0, y: 0, z: 0 })
  })
  assert.ok(await page.getByText('丝境', { exact: true }).count())
  for (const id of ['silk-studio', 'tidal-studio', 'dune-studio', 'glass-studio']) {
    await page.evaluate((id) => window.__jap.useViz.getState().setScene(id), id)
    await page.waitForFunction((id) => window.__japViz.currentId === id, id)
    await page.waitForTimeout(1200)
    assert.equal(await page.evaluate(() => window.__japViz.lastRenderError), null)
    await page.screenshot({ path: path.join(out, id + '.png') })
  }
  checks.push('All four studio shaders compile and render without black frames')
  for (const id of [
    'orb',
    'galaxy',
    'tunnel',
    'city',
    'ribbon',
    'plasma',
    'terrain',
    'scope',
    'spectrum',
    'spectrogram',
    'vectorscope',
    'vu',
  ]) {
    await page.evaluate(async (id) => {
      window.__jap.useSettings.getState().update({ enabledLegacyVisuals: [id] })
      await window.__jap.prepareScenes()
      window.__jap.useViz.getState().setScene(id)
    }, id)
    await page.waitForFunction((id) => window.__japViz.currentId === id, id)
    await page.waitForTimeout(150)
    assert.ok(
      await page.evaluate(() => !!window.__japViz.current.nativeShader()),
      id + ' has shared native HDR shader'
    )
    assert.deepEqual(
      await page.evaluate(() => window.__jap.useSettings.getState().enabledLegacyVisuals),
      [id]
    )
    assert.equal(await page.evaluate(() => window.__japViz.lastRenderError), null)
    if(id==='vu') {
      await page.evaluate(path=>{const p=__jap.usePlayer.getState();p.setOutput({api:'null',dsdMode:'pcm'});p.setVolume(0);p.play(path)},vuTone)
      await page.waitForFunction(()=>__jap.usePlayer.getState().position.ms>700)
      const meter=await page.evaluate(()=>__japViz.current.nativeShader().uniforms.uVu)
      assert.ok(meter[0]>.48&&meter[0]<.61&&meter[1]>.32&&meter[1]<.43,JSON.stringify(meter))
      assert.ok(meter[2]>meter[0]&&meter[3]>meter[1])
      await page.screenshot({path:path.join(out,'vu.png')})
      await page.evaluate(()=>__jap.usePlayer.getState().stop())
      checks.push('Opt-in VU follows actual stereo RMS with independent peak-hold pointers')
    }
  }
  await page.evaluate(() =>
    window.__jap.useSettings.getState().update({ enabledLegacyVisuals: [] })
  )
  await page.waitForFunction(() => window.__japViz.currentId === 'silk-studio')
  checks.push('All twelve additional effects including opt-in VU expose shared HDR shaders')
  const plugin = {
      apiVersion: 1,
      id: 'qa-plugin',
      name: '插件测试',
      author: 'B5-Software',
      license: 'CC0-1.0',
      description: '原创渐变测试',
      fragment: 'vec3 visualize(vec2 uv){return background(uv)+uAccent*.05;}',
    },
    file = path.join(out, 'original.japviz.json')
  fs.writeFileSync(file, JSON.stringify(plugin))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await answerNextFileDialog(page, file)
  await page.getByRole('button', { name: '导入效果插件 · JSON / GLSL', exact: true }).click()
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  await page.waitForFunction(() => window.__japViz.currentId === 'user-qa-plugin')
  await page.getByRole('button', { name: '卸下插件', exact: true }).click()
  await page.waitForFunction(() => window.__japViz.currentId === 'silk-studio')
  checks.push('Portable JSON shader installs via themed modal and unplugs live')
  await page.evaluate(() =>
    window.__jap.useSettings
      .getState()
      .update({ disabledVisuals: ['silk-studio', 'tidal-studio', 'dune-studio', 'glass-studio'] })
  )
  await page.waitForFunction(() => window.__japViz.currentId === 'cover-studio')
  checks.push('Disabling all effects retains the cover stage')
  assert.deepEqual(errors, [])
  const codecs = await page.evaluate(async () => ({
    api: typeof VideoEncoder,
    supported:
      typeof VideoEncoder === 'undefined'
        ? false
        : await VideoEncoder.isConfigSupported({
            codec: 'avc1.420028',
            width: 1280,
            height: 720,
            framerate: 30,
            bitrate: 6000000,
            avc: { format: 'annexb' },
          }),
  }))
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ status: 'passed', checks, codecs }, null, 2)
  )
  console.log(JSON.stringify({ status: 'passed', checks, codecs }, null, 2))
} finally {
  await app.close()
}
