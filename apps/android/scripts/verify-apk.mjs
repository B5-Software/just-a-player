import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const apk = process.argv[2] || join(root, 'app/build/outputs/apk/release/app-release.apk')

// Windows bsdtar reads ZIP; Linux GNU tar does not.
function archive(file) {
  const windows = process.platform === 'win32'
  const args = windows
    ? file
      ? ['-xOf', apk, file]
      : ['-tf', apk]
    : file
      ? ['-p', apk, file]
      : ['-Z1', apk]
  const result = spawnSync(
    windows ? 'tar' : 'unzip',
    args,
    file ? { maxBuffer: 32 * 1024 * 1024 } : { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message)
  return result.stdout
}

const entries = archive().split(/\r?\n/)
assert.equal(
  entries.includes('assets/soundfonts/MuseScore_General_HQ.sf2'),
  process.env.JAP_BUNDLE_MIDI !== '0',
  'Wrong MIDI resource variant'
)
const targets = [
  ['arm64-v8a', 2, 183],
  ['armeabi-v7a', 1, 40],
  ['x86', 1, 3],
  ['x86_64', 2, 62],
]
const report = { apk, bytes: statSync(apk).size, libraries: [] }

for (const [abi, bits, machine] of targets) {
  for (const name of ['libjap_android.so', 'libffmpeg.so', 'libffprobe.so']) {
    const file = `lib/${abi}/${name}`
    assert.ok(entries.includes(file), file)
    const b = archive(file)
    assert.equal(b.subarray(0, 4).toString('hex'), '7f454c46')
    assert.equal(b[4], bits)
    assert.equal(b[5], 1)
    assert.equal(b.readUInt16LE(18), machine)
    const offset = bits === 2 ? Number(b.readBigUInt64LE(32)) : b.readUInt32LE(28)
    const size = b.readUInt16LE(bits === 2 ? 54 : 42)
    const count = b.readUInt16LE(bits === 2 ? 56 : 44)
    let loads = 0
    for (let n = 0; n < count; n++) {
      const p = offset + n * size
      if (b.readUInt32LE(p) !== 1) continue
      loads++
      const alignment = bits === 2 ? Number(b.readBigUInt64LE(p + 48)) : b.readUInt32LE(p + 28)
      assert.ok(alignment >= 16384, `${file}: ELF segment alignment ${alignment}`)
    }
    assert.ok(loads > 0)
    report.libraries.push({ abi, name, machine, pageAlignment: 16384 })
  }
}

assert.equal(entries.filter((e) => /^lib\/[^/]+\/libjap_android\.so$/.test(e)).length, 4)
assert.ok(
  !entries.some((e) => e.endsWith('/libc++_shared.so')),
  'Old 4-KiB NDK runtime must not be shipped'
)
mkdirSync(join(root, 'test-results'), { recursive: true })
writeFileSync(join(root, 'test-results/apk.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
