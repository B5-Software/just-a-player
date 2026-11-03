import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const audio = readFileSync(new URL('../src/utility/external/netease-audio.js', import.meta.url), 'utf8')
function bootstrap({ force, version, pointerSize = 8, name = 'avcodec-58.dll' }) {
  const hooks = [], messages = []
  const codec = { name, getExportByName: key => key }
  const context = {
    Process: {
      pointerSize,
      findModuleByName: key => key === name ? codec : null,
      enumerateModules: () => [codec],
    },
    NativeFunction: function (name) { return () => name === 'avcodec_version' ? version : 0 },
    Interceptor: { attach: (name) => { hooks.push(name); return { detach() {} } } },
    rpc: { exports: {} }, send: value => messages.push(value),
  }
  runInNewContext(audio.replace('__FORCE__', String(force)), context)
  return { hooks, messages }
}
assert.throws(() => bootstrap({ force: false, version: 3824485 }), /强制接管/)
assert(bootstrap({ force: true, version: 3824485 }).hooks.includes('avcodec_receive_frame'))
assert(bootstrap({ force: true, version: 4000000, name: 'avcodec-60.dll' }).hooks.includes('avcodec_send_packet'))
assert.throws(() => bootstrap({ force: true, version: 3824484, pointerSize: 4 }), /64 位/)
assert(bootstrap({ force: false, version: 3824484 }).messages.some(m => m.event === 'audioReady'))
console.log('External adapter version gates: normal, forced, renamed module, native pointer ABI passed.')
