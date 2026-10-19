import { app, dialog, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { create } from 'fontkit'
import type { ImportedFont } from '../shared/settings'

const MAX_BYTES = 64 * 1024 * 1024
const folder = (): string => join(app.getPath('userData'), 'fonts')
let catalog: ImportedFont[] | null = null
export function listFonts(): ImportedFont[] {
  if (!catalog) {
    try {
      const data: unknown = JSON.parse(readFileSync(join(folder(), 'index.json'), 'utf8'))
      catalog = Array.isArray(data)
        ? data
            .filter(
              (f): f is ImportedFont =>
                f &&
                /^user-[a-f0-9]{64}$/.test(f.id) &&
                f.family === `JAP-${f.id}` &&
                typeof f.label === 'string' &&
                Number.isFinite(f.weight)
            )
            .slice(0, 256)
        : []
    } catch {
      catalog = []
    }
  }
  return catalog
}
export async function fontData(id: string): Promise<Buffer | null> {
  if (!listFonts().some((f) => f.id === id)) return null
  const path = join(folder(), `${id}.font`)
  const info = await stat(path).catch(() => null)
  return info?.isFile() && info.size <= MAX_BYTES ? readFile(path) : null
}

/** Extract complete SFNT faces from TTC/OTC, retaining cmap, shaping and color tables. */
function faces(data: Buffer): Buffer[] {
  if (data.toString('ascii', 0, 4) !== 'ttcf') return [data]
  const count = data.readUInt32BE(8)
  if (!count || count > 64 || 12 + count * 4 > data.length)
    throw new Error('字体集合无效或超过 64 个字面')
  return Array.from({ length: count }, (_, face) => {
    const offset = data.readUInt32BE(12 + face * 4)
    if (offset + 12 > data.length) throw new Error('字体目录越界')
    const n = data.readUInt16BE(offset + 4)
    if (!n || n > 256 || offset + 12 + n * 16 > data.length) throw new Error('字体表目录无效')
    const tables = Array.from({ length: n }, (_, i) => {
      const row = offset + 12 + i * 16,
        start = data.readUInt32BE(row + 8),
        length = data.readUInt32BE(row + 12)
      if (start + length > data.length) throw new Error('字体表越界')
      return {
        tag: data.toString('ascii', row, row + 4),
        checksum: data.readUInt32BE(row + 4),
        start,
        length
      }
    }).filter((t) => t.tag !== 'DSIG')
    const size = 12 + tables.length * 16 + tables.reduce((sum, t) => sum + ((t.length + 3) & ~3), 0)
    if (size > MAX_BYTES) throw new Error('字体字面超过 64 MB')
    const out = Buffer.alloc(size),
      power = 2 ** Math.floor(Math.log2(tables.length))
    data.copy(out, 0, offset, offset + 4)
    out.writeUInt16BE(tables.length, 4)
    out.writeUInt16BE(power * 16, 6)
    out.writeUInt16BE(Math.log2(power), 8)
    out.writeUInt16BE(tables.length * 16 - power * 16, 10)
    let at = 12 + tables.length * 16,
      head = 0
    tables.forEach((t, i) => {
      const row = 12 + i * 16
      out.write(t.tag, row, 4, 'ascii')
      out.writeUInt32BE(t.checksum, row + 4)
      out.writeUInt32BE(at, row + 8)
      out.writeUInt32BE(t.length, row + 12)
      data.copy(out, at, t.start, t.start + t.length)
      if (t.tag === 'head' && t.length >= 12) {
        head = at
        out.writeUInt32BE(0, at + 8)
      }
      at += (t.length + 3) & ~3
    })
    if (head) {
      let checksum = 0
      for (let i = 0; i < out.length; i += 4) checksum = (checksum + out.readUInt32BE(i)) >>> 0
      out.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8)
    }
    return out
  })
}

export async function importFonts(
  win: BrowserWindow
): Promise<{ fonts: ImportedFont[]; errors: string[] }> {
  const picked = await dialog.showOpenDialog(win, {
    title: '导入字体',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc'] }]
  })
  const added: ImportedFont[] = [],
    errors: string[] = []
  if (picked.canceled) return { fonts: [], errors }
  await mkdir(folder(), { recursive: true })
  for (const path of picked.filePaths.slice(0, 32)) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('文件超过 64 MB')
      for (const face of faces(await readFile(path))) {
        const font = create(face)
        if ('fonts' in font) throw new Error('不支持压缩的字体集合，请使用 TTC/OTC 原始集合')
        const id: ImportedFont['id'] = `user-${createHash('sha256').update(face).digest('hex')}`
        const entry: ImportedFont = {
          id,
          label: (font.fullName || font.familyName || basename(path)).slice(0, 100),
          family: `JAP-${id}`,
          weight: 400
        }
        if (listFonts().length >= 256 && !listFonts().some((f) => f.id === id))
          throw new Error('最多保留 256 款导入字体')
        await writeFile(join(folder(), `${id}.font`), face)
        if (!listFonts().some((f) => f.id === id)) listFonts().push(entry)
        added.push(entry)
      }
    } catch (e) {
      errors.push(`${basename(path)}：${String(e)}`)
    }
  }
  await writeFile(join(folder(), 'index.json'), JSON.stringify(listFonts(), null, 2))
  return { fonts: added, errors }
}
