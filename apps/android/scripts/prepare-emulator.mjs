// Prepare only the disposable 16-KiB CI emulator. The emulator action executes
// each input line separately, so keep control flow in this standalone program.
import assert from 'node:assert/strict'
import { adb, delay } from './emulator-cdp.mjs'

assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu'), '1', 'QA preparation is emulator-only')
assert.equal(adb('shell', 'getconf', 'PAGESIZE'), '16384', 'QA requires the 16-KiB system image')
console.log(adb('shell', 'cat', '/proc/meminfo'))
console.log(adb('shell', 'dumpsys', 'webviewupdate'))
adb('shell', 'svc', 'wifi', 'disable')
adb('shell', 'svc', 'data', 'disable')

const installed = new Set(adb('shell', 'pm', 'list', 'packages').split(/\r?\n/).map(line => line.replace(/^package:/, '').trim()))
// Disable telephony before GMS so its warning cannot interrupt audio focus.
// Partner setup and wellbeing otherwise create a first-boot memory storm.
for (const name of [
  'com.android.vending',
  'com.google.android.googlequicksearchbox',
  'com.google.android.dialer',
  'com.google.android.apps.messaging',
  'com.google.android.partnersetup',
  'com.google.android.apps.wellbeing',
  'com.google.android.apps.restore',
  'com.google.android.setupwizard',
  'com.google.android.gms',
]) {
  if (installed.has(name)) console.log(adb('shell', 'pm', 'disable-user', '--user', '0', name))
}
await delay(5000)
console.log(adb('shell', 'cat', '/proc/meminfo'))
