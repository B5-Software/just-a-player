import { execFileSync } from 'node:child_process'
const hdc =
  process.env.HDC_PATH ??
  'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
export const serial = process.env.JAP_HARMONY_SERIAL ?? '127.0.0.1:10671'
export const shell = (command) =>
  execFileSync(hdc, ['-t', serial, 'shell', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim()
export async function connect() {
  const pid = shell('pidof org.b5_software.justaplayer').split(' ')[0]
  const forwards = execFileSync(hdc, ['-t', serial, 'fport', 'ls'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  for (const line of forwards.split('\n')) {
    const old = /tcp:9337\s+(localabstract:\S+)/.exec(line)
    if (old && old[1] !== `localabstract:webview_devtools_remote_${pid}`)
      execFileSync(hdc, ['-t', serial, 'fport', 'rm', 'tcp:9337', old[1]], { windowsHide: true })
  }
  execFileSync(
    hdc,
    ['-t', serial, 'fport', 'tcp:9337', `localabstract:webview_devtools_remote_${pid}`],
    { windowsHide: true }
  )
  const targets = await (await fetch('http://127.0.0.1:9337/json')).json()
  const target = targets.find(
    (t) => t.url.includes('/web/') || t.url.startsWith('https://jap.localhost/')
  )
  if (!target) throw Error('No Just A Player ArkWeb target')
  const ws = new WebSocket(target.webSocketDebuggerUrl),
    pending = new Map()
  let next = 0
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id) {
      const p = pending.get(m.id)
      if (p) {
        pending.delete(m.id)
        m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    } else if (
      m.method === 'Runtime.exceptionThrown' ||
      (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    )
      console.error(JSON.stringify(m))
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  return {
    send,
    evaluate,
    close() {
      ws.close()
      for (const p of pending.values()) p.reject(Error('CDP closed'))
      pending.clear()
    },
  }
}
