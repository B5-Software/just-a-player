// Exact DXGI GPU selection, real float HDR image transfer, retained frames,
// accent interpolation and wallpaper live/static transitions.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
const cwd = resolve(fileURLToPath(import.meta.url), '../..'),
  out = join(tmpdir(), 'jap-render-qa'),
  settings = join(tmpdir(), 'jap-e2e-userdata', 'settings.json')
mkdirSync(out, { recursive: true })
mkdirSync(dirname(settings), { recursive: true })
const original = existsSync(settings) ? readFileSync(settings, 'utf8') : '{}',
  saved = JSON.parse(original),
  checks = {},
  errors = []
let app, page
const assert = (v, m) => {
  if (!v) throw new Error(m)
}
const launch = async (id) => {
  writeFileSync(
    settings,
    JSON.stringify({
      ...saved,
      renderGpu: id,
      wallpaperEnabled: false,
      argbEnabled: false,
      hdrEnabled: false
    })
  )
  app = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd,
    env: { ...process.env, JAP_E2E: 'renderer' }
  })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(30000)
  await page.waitForFunction(
    () => window.__jap?.usePlayer.getState().connected && window.__japViz?.lastDraw > 0
  )
  const render = await page.evaluate(() => ({
    error: window.__japViz.lastRenderError,
    rejected: window.__japViz.rejectedFrames,
    frames: window.__japViz.frameVersion
  }))
  assert(!render.error, JSON.stringify(render))
}
const fakeHDR = () => {
  window.__savedMatch = window.matchMedia.bind(window)
  window.matchMedia = (q) =>
    q.includes('dynamic-range') ? { matches: true, media: q } : window.__savedMatch(q)
}
try {
  await launch('auto')
  const initial = await page.evaluate(() => window.jap.gpuInfo())
  checks.adapters = []
  const choices = initial.adapters.filter((g, i, a) => a.findIndex((v) => v.name === g.name) === i)
  for (const g of choices) {
    await app.close()
    app = null
    await launch(g.id)
    const info = await page.evaluate(() => window.jap.gpuInfo())
    checks.adapters.push(info)
    assert(
      info.selected === g.id && info.current.includes(g.name),
      `GPU selection failed: ${JSON.stringify(info)}`
    )
  }
  await app.close()
  app = null
  await launch('auto')
  await page.evaluate(() => {
    const j = window.__jap
    j.useSettings.getState().update({
      autoAccent: false,
      accent: '#e43a61',
      lyricsMode: '3d',
      renderFps: 30,
      lyricsVisible: true,
      autoScan: false
    })
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('orb')
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  })
  await page.waitForTimeout(1000)
  checks.accent = await page.evaluate(async () => {
    const color = () =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const before = color()
    window.__jap.useSettings.getState().update({ accent: '#22ccbb' })
    const immediate = color()
    await new Promise((r) => setTimeout(r, 180))
    const middle = color()
    await new Promise((r) => setTimeout(r, 900))
    return { before, immediate, middle, end: color() }
  })
  assert(
    checks.accent.before === checks.accent.immediate &&
      checks.accent.middle !== checks.accent.before &&
      checks.accent.middle !== checks.accent.end &&
      checks.accent.end === '34 204 187',
    'Accent changed without interpolation'
  )
  checks.retention = await page.evaluate(async () => {
    const v = window.__japViz,
      old = v.post.render.bind(v.post),
      before = v.rejectedFrames,
      version = v.frameVersion
    v.post.render = () => {
      const g = v.renderer.getContext()
      g.bindFramebuffer(g.FRAMEBUFFER, null)
      g.clearColor(0, 0, 0, 1)
      g.clear(g.COLOR_BUFFER_BIT)
    }
    await new Promise((r) => setTimeout(r, 160))
    const held = v.frameVersion === version
    v.post.render = old
    return { held, rejected: v.rejectedFrames - before, data: v.lastFrame.toDataURL() }
  })
  assert(
    checks.retention.held && checks.retention.rejected > 0,
    'Black frames replaced the last valid image'
  )
  writeFileSync(
    join(out, 'retained-frame.png'),
    Buffer.from(checks.retention.data.split(',')[1], 'base64')
  )
  delete checks.retention.data
  await page.evaluate(fakeHDR)
  await page.evaluate(() => window.__jap.useSettings.getState().update({ hdrEnabled: true }))
  await page.waitForFunction(
    () =>
      window.__jap.useHdr.getState().active &&
      window.__japViz.hdr.canvas.style.visibility === 'visible'
  )
  checks.hdr = await page.evaluate(async () => {
    const h = window.__japViz.hdr,
      c = document.createElement('canvas')
    c.width = c.height = 4
    const g = c.getContext('webgl2', { alpha: true, preserveDrawingBuffer: true })
    g.getExtension('EXT_color_buffer_float')
    g.drawingBufferStorage(g.RGBA16F, 4, 4)
    const p = g.createProgram()
    for (const [type, source] of [
      [
        g.VERTEX_SHADER,
        '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}'
      ],
      [
        g.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(4,2,.5,1);}'
      ]
    ]) {
      const s = g.createShader(type)
      g.shaderSource(s, source)
      g.compileShader(s)
      g.attachShader(p, s)
    }
    g.linkProgram(p)
    g.useProgram(p)
    g.drawArrays(g.TRIANGLES, 0, 3)
    h.present(c)
    const d = h.gpu,
      b = d.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      e = d.createCommandEncoder()
    e.copyTextureToBuffer({ texture: h.image }, { buffer: b, bytesPerRow: 256 }, [1, 1])
    d.queue.submit([e.finish()])
    await b.mapAsync(GPUMapMode.READ)
    const values = [...new Uint16Array(b.getMappedRange()).slice(0, 4)]
    b.unmap()
    b.destroy()
    g.getExtension('WEBGL_lose_context').loseContext()
    return {
      configuration: {
        format: h.context.getConfiguration().format,
        mode: h.context.getConfiguration().toneMapping.mode
      },
      halfFloat: values
    }
  })
  assert(
    checks.hdr.configuration.format === 'rgba16float' &&
      checks.hdr.configuration.mode === 'extended' &&
      checks.hdr.halfFloat[0] === 17408 &&
      checks.hdr.halfFloat[1] === 16384,
    'HDR GPU transfer clamped brightness above SDR white'
  )
  const version = await page.evaluate(() => {
    const v = window.__japViz
    window.__hdrLoss = v.renderer.getContext().getExtension('WEBGL_lose_context')
    window.__hdrLoss.loseContext()
    return v.frameVersion
  })
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__hdrLoss.restoreContext())
  await page.waitForFunction((version) => {
    const v = window.__japViz,
      g = v.renderer.getContext()
    return (
      !v.contextLost &&
      v.frameVersion > version &&
      v.hdr.active &&
      g.drawingBufferFormat === g.RGBA16F
    )
  }, version)
  checks.hdrContextRecovered = true
  const created = app.waitForEvent('window')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ wallpaperEnabled: true }))
  const wall = await created
  wall.on('pageerror', (e) => errors.push(e.message))
  await wall.waitForFunction(() => window.__japViz)
  await wall.evaluate(fakeHDR)
  await page.getByRole('button', { name: '悬浮播放', exact: true }).click()
  await wall.waitForFunction(() => window.__japViz.hdr.canvas.style.visibility === 'visible')
  await wall.waitForFunction(() =>
    [
      ...document.querySelectorAll('[data-wallpaper-display] canvas[data-hdr-presenter="scene"]')
    ].every((c) => c.style.visibility === 'visible')
  )
  checks.wallpaperHDRMirror = await wall.evaluate(async () => {
    const v = window.__japViz,
      m = [...window.__japWallpaperMirrors.values()][0],
      h = m.hdrScene,
      g = v.renderer.getContext()
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    const program = g.createProgram()
    const shaders = []
    for (const [type, source] of [
      [
        g.VERTEX_SHADER,
        '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}'
      ],
      [
        g.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(4,2,.5,1);}'
      ]
    ]) {
      const s = g.createShader(type)
      g.shaderSource(s, source)
      g.compileShader(s)
      g.attachShader(program, s)
      shaders.push(s)
    }
    g.linkProgram(program)
    g.useProgram(program)
    g.bindVertexArray(null)
    g.disable(g.DEPTH_TEST)
    g.disable(g.SCISSOR_TEST)
    g.disable(g.BLEND)
    g.colorMask(true, true, true, true)
    g.viewport(0, 0, g.drawingBufferWidth, g.drawingBufferHeight)
    g.drawArrays(g.TRIANGLES, 0, 3)
    const sourcePixel = new Float32Array(4)
    g.readPixels(0, 0, 1, 1, g.RGBA, g.FLOAT, sourcePixel)
    v.mirrorHDR(h)
    const d = h.gpu,
      b = d.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      e = d.createCommandEncoder()
    e.copyTextureToBuffer({ texture: h.image }, { buffer: b, bytesPerRow: 256 }, [1, 1])
    d.queue.submit([e.finish()])
    v.renderer.resetState()
    g.deleteProgram(program)
    shaders.forEach((s) => g.deleteShader(s))
    await b.mapAsync(GPUMapMode.READ)
    const values = [...new Uint16Array(b.getMappedRange()).slice(0, 4)]
    b.unmap()
    b.destroy()
    return {
      values,
      sourcePixel: [...sourcePixel],
      color: g.drawingBufferColorSpace,
      mapping: g.drawingBufferToneMapping,
      format: g.drawingBufferFormat,
      expected: g.RGBA16F,
      active: v.hdr.active,
      error: g.getError()
    }
  })
  assert(
    checks.wallpaperHDRMirror.values[0] === 17408 && checks.wallpaperHDRMirror.values[1] === 16384,
    'Multi-monitor mirror clamped HDR: ' + JSON.stringify(checks.wallpaperHDRMirror)
  )
  checks.wallpaperHDR = true
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.jap.setWindowMode('normal'))
    await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended === '1')
    const filter = await wall.locator('[data-wallpaper-snapshot]').evaluate((el) => ({
      filter: getComputedStyle(el).filter,
      duration: getComputedStyle(el).transitionDuration,
      src: [...el.querySelectorAll('canvas')].some(
        (c) => c.width > 300 && getComputedStyle(c).visibility === 'visible'
      )
    }))
    assert(
      filter.duration.includes('0.85s') && filter.src,
      'Wallpaper blur has no transition/decoded snapshot'
    )
    await page.evaluate(() => window.jap.setWindowMode('mini'))
    await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended !== '1')
    const peak = await wall.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 16
      c.height = 9
      const x = c.getContext('2d')
      x.drawImage(window.__japViz.lastFrame, 0, 0, 16, 9)
      return Math.max(...x.getImageData(0, 0, 16, 9).data.filter((_, i) => i % 4 !== 3))
    })
    assert(peak > 12, 'Wallpaper presented a black retained frame')
  }
  checks.wallpaperTransitions = 8
  await page.evaluate(() => {
    window.matchMedia = window.__savedMatch
    window.__jap.useSettings.getState().update({ hdrEnabled: false, wallpaperEnabled: false })
  })
  assert(errors.length === 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, checks, out }, null, 2))
} catch (e) {
  errors.push(String(e))
  process.exitCode = 1
  console.error(e)
} finally {
  if (app) await app.close()
  writeFileSync(settings, original)
  writeFileSync(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
}
