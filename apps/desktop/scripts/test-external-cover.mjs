import assert from 'node:assert/strict'
import { responseCover, rasterCover, MAX_COVER_BYTES } from '../src/utility/external-cover.ts'
const jpeg = new Uint8Array([255,216,255,224,0,16,74,70,73,70])
for (const mime of ['image/jpg','image/jpeg','IMAGE/JPG; charset=binary','application/octet-stream']) {
  const cover=await responseCover(new Response(jpeg,{headers:{'content-type':mime}}))
  assert.equal(cover.mime,'image/jpeg')
  assert.deepEqual(Array.from(cover.data),Array.from(jpeg))
}
await assert.rejects(responseCover(new Response('<html>not a cover</html>',{headers:{'content-type':'image/jpg'}})),/图片/)
await assert.rejects(responseCover(new Response(jpeg,{status:503})),/503/)
await assert.rejects(responseCover(new Response(jpeg,{headers:{'content-length':String(MAX_COVER_BYTES+1)}})),/预算/)
await assert.rejects(responseCover(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_COVER_BYTES));c.enqueue(jpeg);c.close()}}))),/预算/)
assert.throws(()=>rasterCover(new Uint8Array()),/图片/)
console.log('Online cover: JPEG aliases, bounded raster validation, HTTP errors and oversized streams passed.')
