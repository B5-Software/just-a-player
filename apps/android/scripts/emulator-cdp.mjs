import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
const adbPath = join(
  process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT,
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb'
)
export function adb(...args) {
  const r = spawnSync(adbPath, ['-s', process.env.ANDROID_SERIAL || 'emulator-5554', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.status !== 0) throw Error(r.stderr || r.stdout)
  return r.stdout.trim()
}
export function adbBytes(...args) {
  const r = spawnSync(adbPath, ['-s', process.env.ANDROID_SERIAL || 'emulator-5554', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw Error(r.stderr?.toString() || 'ADB binary read failed')
  return r.stdout
}
/** Feed a QA fixture to the app UID; shell-owned scoped-storage folders can be unreadable. */
export function adbInput(input, ...args) {
  const r = spawnSync(adbPath, ['-s', process.env.ANDROID_SERIAL || 'emulator-5554', ...args], {
    input,
    stdio: ['pipe', 'ignore', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: 30000,
  })
  if (r.status !== 0) throw Error(r.stderr?.toString() || r.error?.message || 'ADB fixture write failed')
}
export const delay = (ms) => new Promise((r) => setTimeout(r, ms))
function removeForward(port) {
  if (!port) return
  try { adb('forward', '--remove', port) } catch { /* Emulator may already have exited. */ }
}
export async function connect(surface = 'main') {
  let ws, lastError, forwardedPort
  const deadline = Date.now() + 45000
  while (!ws && Date.now() < deadline) {
    const sockets = adb('shell', 'cat', '/proc/net/unix')
    const matches = [...new Set(sockets.match(/@webview_devtools_remote_\d+/g) ?? [])]
    for (const entry of matches) {
      let candidate, port
      try {
        // A fresh port also gives Node a fresh HTTP pool. Rebinding one port
        // after force-stop can keep /json requests on the previous WebView's TCP connection.
        const number = adb('forward', 'tcp:0', `localabstract:${entry.slice(1)}`)
        if (!/^\d+$/.test(number)) throw Error('ADB did not allocate a debugger port')
        port = `tcp:${number}`
        const targets = await (
          await fetch(`http://127.0.0.1:${number}/json`, {
            headers: { Connection: 'close' },
            signal: AbortSignal.timeout(3000),
          })
        ).json()
        const target = targets.find(
          (t) =>
            t.url.includes('appassets.androidplatform.net') &&
            t.url.includes('surface=export') === (surface === 'export')
        )
        if (!target) { removeForward(port); continue }
        // WebView can advertise localhost or a device-side port. Use the exact
        // IPv4 endpoint we forwarded, including on Node/Linux IPv6 hosts.
        const url = new URL(target.webSocketDebuggerUrl)
        url.hostname = '127.0.0.1'
        url.port = number
        candidate = new WebSocket(url)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('WebView handshake timed out')), 3000)
          candidate.onopen = () => { clearTimeout(timer); resolve() }
          candidate.onerror = () => { clearTimeout(timer); reject(Error('WebView handshake failed')) }
          candidate.onclose = () => { clearTimeout(timer); reject(Error('WebView target closed')) }
        })
        ws = candidate
        forwardedPort = port
        break
      } catch (error) {
        lastError = error
        candidate?.close()
        removeForward(port)
        // A renderer can exit between discovery and opening its debugger.
      }
    }
    if (!ws) await delay(250)
  }
  if (!ws) throw Error('Player WebView target not found: ' + String(lastError ?? 'no target'))
  let next = 1
  const pending = new Map()
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const item = pending.get(m.id)
      if (item) {
        pending.delete(m.id)
        clearTimeout(item.timer)
        m.error ? item.reject(Error(JSON.stringify(m.error))) : item.resolve(m.result)
      }
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
  }
  ws.onclose = () => {
    removeForward(forwardedPort)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(Error('WebView debugger disconnected'))
    }
    pending.clear()
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Error(`WebView debugger timed out: ${method}`))
      }, 45000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return {
    evaluate,
    send,
    errors,
    close: () => ws.close(),
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })
      const fs = await import('node:fs/promises')
      await fs.mkdir(new URL('../test-results/', import.meta.url), {
        recursive: true,
      })
      await fs.writeFile(path, Buffer.from(data, 'base64'))
    },
  }
}
