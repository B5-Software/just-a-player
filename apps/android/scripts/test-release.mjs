import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { adb, adbBytes, delay } from './emulator-cdp.mjs'
const root = fileURLToPath(new URL('..', import.meta.url)),
  apk = process.argv[2] || path.join(root, 'app/build/outputs/apk/release/app-release.apk')
if (!fs.existsSync(apk)) {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    console.log(
      'Fork/PR: release signing secrets are unavailable; debug QA already covers playback.'
    )
    process.exit(0)
  }
  throw Error('Missing signed release APK')
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT,
  tools = path.join(sdk, 'build-tools/35.0.0'),
  windows = process.platform === 'win32'
assert.equal(
  adb('shell', 'getprop', 'ro.build.type'),
  'user',
  'Release debugger checks require a user image; userdebug/eng force WebView debugging. Use google_apis_playstore_ps16k.'
)
const java =
  windows && fs.existsSync('C:/Program Files/Java/jdk-21/bin/java.exe')
    ? 'C:/Program Files/Java/jdk-21/bin/java.exe'
    : 'java'
function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const badging = run(path.join(tools, windows ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk])
assert.match(badging, /name='org\.b5_software\.justaplayer'/)
assert.match(badging, /versionName='0\.1\.3'/)
assert.doesNotMatch(badging, /application-debuggable/)
const signature = run(java, [
  '-jar',
  path.join(tools, 'lib/apksigner.jar'),
  'verify',
  '--verbose',
  '--print-certs',
  apk,
])
run(path.join(tools, windows ? 'zipalign.exe' : 'zipalign'), ['-c', '-P', '16', '4', apk])
const checks = [
  'Release manifest is non-debuggable and versioned 0.1.3',
  'APK signature verified',
  'APK 16 KiB ZIP alignment verified',
]
adb('shell', 'am', 'force-stop', 'org.b5_software.justaplayer.debug')
adb('install', '-r', apk)
adb(
  'push',
  path.join(root, 'test-results/fixtures/Android HiFi.wav'),
  '/sdcard/Music/ReleaseHiFi.wav'
)
let rows = adb(
  'shell',
  'content',
  'query',
  '--uri',
  'content://media/external/audio/media',
  '--projection',
  '_id:_display_name'
)
let id = rows.match(/_id=(\d+), _display_name=ReleaseHiFi.wav/)?.[1]
if (!id) {
  adb(
    'shell',
    'content',
    'insert',
    '--uri',
    'content://media/external/audio/media',
    '--bind',
    '_data:s:/storage/emulated/0/Music/ReleaseHiFi.wav',
    '--bind',
    '_display_name:s:ReleaseHiFi.wav',
    '--bind',
    'mime_type:s:audio/wav'
  )
  rows = adb(
    'shell',
    'content',
    'query',
    '--uri',
    'content://media/external/audio/media',
    '--projection',
    '_id:_display_name'
  )
  id = rows.match(/_id=(\d+), _display_name=ReleaseHiFi.wav/)?.[1]
}
assert.ok(id)
const app = 'org.b5_software.justaplayer'
adb('shell', 'am', 'force-stop', app)
adb(
  'shell',
  'am',
  'start',
  '-W',
  '-n',
  app + '/org.b5_software.justaplayer.MainActivity',
  '-a',
  'android.intent.action.VIEW',
  '-t',
  'audio/wav',
  '-d',
  `content://media/external/audio/media/${id}`,
  '-f',
  '0x10000001'
)
async function media(state) {
  for (let n = 0; n < 100; n++) {
    const dump = adb('shell', 'dumpsys', 'media_session')
    const start = dump.indexOf('    Just A Player ' + app + '/')
    const record = start < 0 ? '' : dump.slice(start).split(/\n    (?=\S)/)[0]
    if (
      record.includes('ReleaseHiFi') &&
      new RegExp('state=(?:[A-Z_]+\\()?' + state + '[,)]').test(record)
    )
      return
    await delay(200)
  }
  throw Error('Release media state did not reach ' + state)
}
await media(3)
checks.push('Installed signed release opens content URI and plays through the native engine')
fs.writeFileSync(
  path.join(root, 'test-results/release.png'),
  adbBytes('exec-out', 'screencap', '-p')
)
adb('shell', 'input', 'keyevent', 'KEYCODE_MEDIA_PAUSE')
await media(2)
checks.push('System pause works in the signed release')
const pids = adb('shell', 'pidof', app).split(/\s+/)
assert.ok(pids.length > 0 && pids.every((pid) => /^\d+$/.test(pid)))
const sockets = [
  ...adb('shell', 'cat', '/proc/net/unix').matchAll(/@webview_devtools_remote_(\d+)(?=\s|$)/g),
].map((match) => match[1])
const exposed = sockets.filter((pid) => pids.includes(pid))
fs.writeFileSync(
  path.join(root, 'test-results/release-debugger.json'),
  JSON.stringify({ pids, sockets, exposed }, null, 2)
)
assert.deepEqual(exposed, [], 'Signed release must not expose its own WebView debugger')
checks.push('Release WebView debugging is disabled')
fs.writeFileSync(
  path.join(root, 'test-results/release.json'),
  JSON.stringify({ status: 'passed', checks, signature }, null, 2)
)
console.log(JSON.stringify({ status: 'passed', checks }, null, 2))
