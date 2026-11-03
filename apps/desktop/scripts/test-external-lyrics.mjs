import assert from 'node:assert/strict'
import { externalLyrics } from '../src/renderer/src/external/lyrics.ts'
import { parseLRC } from '../src/renderer/src/lyrics/parse.ts'

const base = { track: { id: 'test' }, lyrics: { trackId: 'test', offset: 0.5, lines: [], translation: [], yrc: '[1000,1200](1000,300,0)甲(1600,400,0)乙' } }
const parsed = parseLRC(externalLyrics(base))
assert.equal(parsed.length, 1)
assert.equal(parsed[0].text, '甲乙')
assert.equal(parsed[0].t, 0.5)
assert.deepEqual(parsed[0].words.map(w => [w.t, w.end, w.text]), [[0.5,0.8,'甲'],[1.1,1.5,'乙']])
assert.equal(externalLyrics({ ...base, track: { id: 'another' } }), null)
const ordinary = { ...base, lyrics: { ...base.lyrics, yrc: '', lines: [{ time: 1.2, lyric: '测试' }], translation: [{ time: 1.2, lyric: 'Test' }] } }
const lrc = parseLRC(externalLyrics(ordinary))
assert.equal(lrc[0].t, 1.2) // Client LRC times already contain its offset.
assert.equal(lrc[0].sub, 'Test')
console.log('External lyric timing, word ends, translations and track association passed')
