import * as THREE from 'three'

// 字形 → 3D 轮廓：位图 + Marching Squares + RDP 简化 + 孔洞嵌套判定。
// 字形直接从已加载的字体在 canvas 上光栅化，所以字体必须先通过 document.fonts 加载。

type Pt = [number, number]

export interface GlyphShapes {
  shapes: THREE.Shape[]
  /** 文本宽度（相对字号）。 */
  w: number
}

interface Loop {
  l: Pt[]
  a: number
  depth: number
  par?: Loop
}

type Edge = 'T' | 'B' | 'L' | 'R'
const EDGES = [
  '',
  'LB',
  'BR',
  'LR',
  'TR',
  'TRLB',
  'TB',
  'TL',
  'TL',
  'TB',
  'TLBR',
  'TR',
  'LR',
  'BR',
  'LB',
  ''
] as const

function pointInLoop(p: Pt, q: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!
    const b = q[j]!
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside
    }
  }
  return inside
}

function loopArea(p: Pt[]): number {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    s += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1]
  }
  return Math.abs(s / 2)
}

function rdp(p: Pt[], i: number, j: number, e: number, keep: Uint8Array): void {
  let m = -1
  let d = e
  const [ax, ay] = p[i]!
  const [bx, by] = p[j]!
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  for (let k = i + 1; k < j; k++) {
    const t = Math.abs((p[k]![0] - ax) * dy - (p[k]![1] - ay) * dx) / len
    if (t > d) {
      d = t
      m = k
    }
  }
  if (m > 0) {
    keep[m] = 1
    rdp(p, i, m, e, keep)
    rdp(p, m, j, e, keep)
  }
}

function simplify(p: Pt[], e: number): Pt[] {
  const n = p.length
  let far = 0
  let farDist = 0
  for (let k = 1; k < n; k++) {
    const d = (p[k]![0] - p[0]![0]) ** 2 + (p[k]![1] - p[0]![1]) ** 2
    if (d > farDist) {
      farDist = d
      far = k
    }
  }
  const q = p.concat([p[0]!])
  const keep = new Uint8Array(n + 1)
  keep[0] = 1
  keep[far] = 1
  keep[n] = 1
  rdp(q, 0, far, e, keep)
  rdp(q, far, n, e, keep)
  return q.filter((_, k) => k < n && keep[k] === 1)
}

export function glyphShapes(text: string, family: string, weight: number): GlyphShapes {
  const R = 256
  const pad = 24
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const font = `${weight} ${R}px "${family}", "Noto Sans SC", sans-serif`
  ctx.font = font
  const tw = Math.ceil(ctx.measureText(text).width)
  canvas.width = tw + pad * 2
  canvas.height = Math.ceil(R * 1.6)
  const W = canvas.width
  const H = canvas.height
  const base = Math.round(R * 1.2)
  ctx.font = font
  ctx.fillStyle = '#fff'
  ctx.fillText(text, pad, base)
  const data = ctx.getImageData(0, 0, W, H).data
  const a = new Uint8Array(W * H)
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3]!

  const adj = new Map<number, number[]>()
  const link = (p: number, q: number): void => {
    ;(adj.get(p) ?? adj.set(p, []).get(p)!).push(q)
    ;(adj.get(q) ?? adj.set(q, []).get(q)!).push(p)
  }
  const hE = (x: number, y: number): number => (y * W + x) * 2
  const vE = (x: number, y: number): number => (y * W + x) * 2 + 1
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x
      const k =
        (a[i]! > 127 ? 8 : 0) |
        (a[i + 1]! > 127 ? 4 : 0) |
        (a[i + W + 1]! > 127 ? 2 : 0) |
        (a[i + W]! > 127 ? 1 : 0)
      if (k === 0 || k === 15) continue
      const e: Record<Edge, number> = { T: hE(x, y), B: hE(x, y + 1), L: vE(x, y), R: vE(x + 1, y) }
      const s = EDGES[k]!
      for (let j = 0; j < s.length; j += 2) link(e[s[j] as Edge], e[s[j + 1] as Edge])
    }
  }

  const pos = (id: number): Pt => {
    const cell = id >> 1
    const x = cell % W
    const y = Math.floor(cell / W)
    const i = y * W + x
    if (id & 1) {
      const t = (127.5 - a[i]!) / (a[i + W]! - a[i]!)
      return [x, y + t]
    }
    const t = (127.5 - a[i]!) / (a[i + 1]! - a[i]!)
    return [x + t, y]
  }

  const seen = new Set<number>()
  const loops: Pt[][] = []
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const l: Pt[] = []
    let prev = -1
    let cur = start
    while (!seen.has(cur)) {
      seen.add(cur)
      l.push(pos(cur))
      const n = adj.get(cur)!
      const next = n[0] !== prev ? n[0] : n[1]
      if (next === undefined) break
      prev = cur
      cur = next
    }
    if (l.length >= 3) loops.push(l)
  }

  const found: Loop[] = loops
    .map((l) => simplify(l, 0.4))
    .filter((l) => l.length >= 3)
    .map((l) => ({ l, a: loopArea(l), depth: 0 }))
    .filter((o) => o.a > 6)
  for (const o of found) {
    const parents = found
      .filter((q) => q.a > o.a && pointInLoop(o.l[0]!, q.l))
      .sort((u, v) => u.a - v.a)
    o.par = parents[0]
    o.depth = parents.length
  }

  const toVectors = (l: Pt[]): THREE.Vector2[] =>
    l.map(([px, py]) => new THREE.Vector2((px - pad - tw / 2) / R, (base - py) / R - 0.38))
  const shapes: THREE.Shape[] = []
  const owners = new Map<Loop, THREE.Shape>()
  for (const o of found.filter((o) => o.depth % 2 === 0)) {
    const shape = new THREE.Shape(toVectors(o.l))
    owners.set(o, shape)
    shapes.push(shape)
  }
  for (const o of found.filter((o) => o.depth % 2 === 1)) {
    const owner = o.par ? owners.get(o.par) : undefined
    owner?.holes.push(new THREE.Path(toVectors(o.l)))
  }
  return { shapes, w: tw / R }
}
