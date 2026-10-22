import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adb, adbBytes, connect, delay } from './emulator-cdp.mjs'
assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu'), '1', 'DPI changes are emulator-only')
const original = adb('shell', 'wm', 'density'),
  override = original.match(/Override density:\s*(\d+)/)?.[1]
const app = 'org.b5_software.justaplayer.debug',
  checks = []
let c
async function connection() {
  c?.close()
  c = await connect()
  for (let i = 0; i < 80; i++) {
    if (await c.evaluate('!!window.__jap&&!!window.__japViz')) return
    await delay(100)
  }
  throw Error('Player did not initialize')
}
async function measure() {
  await delay(1000)
  return c.evaluate(
    `(()=>{const d=document.querySelector('[data-now-playing]').getBoundingClientRect(),canvas=__japViz.renderer.domElement;return {width:innerWidth,height:innerHeight,dockHeight:d.height,dockBottom:d.bottom,canvas:[canvas.width,canvas.height],viewport:JSON.parse(NativeAndroid.snapshot()).viewport}})()`
  )
}
try {
  adb(
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    app + '/org.b5_software.justaplayer.MainActivity',
    '--ez',
    'e2e',
    'true'
  )
  await connection()
  await c.evaluate(
    '__jap.useUi.getState().setOnboardingOpen(false);__jap.useSettings.getState().update({enabledLegacyVisuals:[],disabledVisuals:["silk-studio","tidal-studio","dune-studio","glass-studio"],androidUiScale:1,renderScale:1,autoHideControls:false,renderFps:15})'
  )
  const baseline = await measure()
  assert.ok(baseline.dockHeight < 125, JSON.stringify(baseline))
  assert.ok(baseline.dockBottom <= baseline.height + 2)
  for (const density of ['320', '560']) {
    adb('shell', 'wm', 'density', density)
    await delay(700)
    await connection()
    const actual = await measure()
    assert.ok(
      Math.abs(actual.width - baseline.width) < 4 && Math.abs(actual.height - baseline.height) < 4,
      JSON.stringify({ baseline, actual })
    )
    assert.ok(actual.canvas.every((v, i) => Math.abs(v - baseline.canvas[i]) <= 3))
    checks.push({ density, ...actual })
  }
  for (const scale of [0.85, 1.3]) {
    await c.evaluate(`__jap.useSettings.getState().update({androidUiScale:${scale}})`)
    const actual = await measure()
    assert.ok(Math.abs(actual.width - baseline.width / scale) < 5)
    assert.ok(actual.dockBottom <= actual.height + 2)
    assert.ok(actual.canvas.every((v, i) => Math.abs(v - baseline.canvas[i]) <= 3))
    checks.push({ manualScale: scale, ...actual })
  }
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2))
  fs.writeFileSync(
    fileURLToPath(new URL('../test-results/layout.json', import.meta.url)),
    JSON.stringify({ status: 'passed', checks }, null, 2)
  )
} finally {
  if (c) {
    await c
      .evaluate('__jap.useSettings.getState().update({androidUiScale:1,disabledVisuals:[]})')
      .catch(() => {})
    c.close()
  }
  adb('shell', 'wm', 'density', override || 'reset')
}
