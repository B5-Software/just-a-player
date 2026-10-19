import { Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { getSettings } from './settings'
import type { LightingStatus } from '../shared/lighting'

const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}
interface Device {
  id: number
  key: string
  name: string
  leds: number
  colors: Buffer
  mode: number
  modeData: Buffer | null
  controlled: boolean
}
class OpenRgb {
  socket: Socket | null = null
  devices: Device[] = []
  error = ''
  ready = false
  private buffer: Buffer = Buffer.alloc(0)
  private pending = new Map<
    string,
    { resolve: (data: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private version = 3
  send(type: number, id = 0, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.socket || this.socket.destroyed) return
    const header = Buffer.alloc(16)
    header.write('ORGB')
    header.writeUInt32LE(id, 4)
    header.writeUInt32LE(type, 8)
    header.writeUInt32LE(payload.length, 12)
    this.socket.write(Buffer.concat([header, payload]))
  }
  private request(type: number, id = 0, payload: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const key = `${type}:${id}`,
        timer = setTimeout(() => {
          this.pending.delete(key)
          reject(new Error('OpenRGB 响应超时'))
        }, 2500)
      this.pending.set(key, { resolve, reject, timer })
      this.send(type, id, payload)
    })
  }
  async connect(port: number): Promise<void> {
    const socket = (this.socket = new Socket())
    socket.setNoDelay(true)
    socket.on('error', (e) => {
      this.error = e.message
    })
    socket.on('close', () => {
      this.ready = false
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('OpenRGB 连接中断'))
      }
      this.pending.clear()
    })
    socket.on('data', (bytes) => {
      this.buffer = Buffer.concat([this.buffer, bytes])
      try {
        while (this.buffer.length >= 16) {
          const h = this.buffer
          if (h.toString('ascii', 0, 4) !== 'ORGB' || h.readUInt32LE(12) > 4 * 1024 * 1024)
            throw new Error('OpenRGB 数据包无效')
          const length = h.readUInt32LE(12)
          if (h.length < 16 + length) break
          const type = h.readUInt32LE(8),
            id = h.readUInt32LE(4),
            data = Buffer.from(h.subarray(16, 16 + length))
          this.buffer = h.subarray(16 + length)
          const key = `${type}:${id}`,
            waiter = this.pending.get(key)
          if (waiter) {
            clearTimeout(waiter.timer)
            this.pending.delete(key)
            waiter.resolve(data)
          }
          // Device indexes are invalid after a hotplug notification. Reconnect
          // before any further writes rather than recoloring a different device.
          if (type === 100) {
            this.devices = []
            this.ready = false
            socket.destroy()
          }
        }
      } catch (e) {
        this.error = String(e)
        socket.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('无法连接 OpenRGB SDK：请启用本地 SDK 服务'))
      }, 2500)
      socket.once('error', (e) => {
        clearTimeout(timeout)
        reject(e)
      })
      socket.connect(port, '127.0.0.1', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.version = Math.min(3, (await this.request(40, 0, u32(3))).readUInt32LE(0))
    this.send(50, 0, Buffer.from('Just A Player\0'))
    const count = (await this.request(0)).readUInt32LE(0)
    if (count > 128) throw new Error('OpenRGB 设备数量超出限制')
    for (let i = 0; i < count; i++)
      this.devices.push(
        this.parse(i, await this.request(1, i, this.version ? u32(this.version) : Buffer.alloc(0)))
      )
    this.ready = true
  }
  private parse(id: number, data: Buffer): Device {
    let at = 0
    const skip = (n: number): void => {
      if (n < 0 || at + n > data.length) throw new Error('OpenRGB 设备数据截断')
      at += n
    }
    const word = (): number => {
      skip(2)
      return data.readUInt16LE(at - 2)
    }
    const integer = (): number => {
      skip(4)
      return data.readUInt32LE(at - 4)
    }
    const string = (): string => {
      const n = word()
      skip(n)
      return data.toString('utf8', at - n, at).replace(/\0+$/, '')
    }
    integer()
    integer()
    const name = string(),
      vendor = this.version >= 1 ? string() : ''
    string()
    string()
    const serial = string(),
      location = string()
    const modes = word(),
      mode = integer(),
      rawModes: Buffer[] = []
    for (let n = 0; n < modes; n++) {
      const begin = at
      string()
      skip(4 * (this.version >= 3 ? 12 : 9))
      const colors = word()
      skip(4 * colors)
      rawModes.push(Buffer.from(data.subarray(begin, at)))
    }
    const zones = word()
    for (let n = 0; n < zones; n++) {
      string()
      skip(16)
      const matrix = word()
      skip(matrix)
    }
    const leds = word()
    for (let n = 0; n < leds; n++) {
      string()
      integer()
    }
    const colors = word(),
      begin = at
    skip(colors * 4)
    return {
      id,
      key: createHash('sha256')
        .update([name, vendor, serial, location, String(id)].join('|'))
        .digest('hex'),
      name,
      leds: colors,
      colors: Buffer.from(data.subarray(begin, at)),
      mode,
      modeData: rawModes[mode] ?? null,
      controlled: false
    }
  }
  private colorPacket(colors: Buffer): Buffer {
    const out = Buffer.alloc(6 + colors.length)
    out.writeUInt32LE(out.length)
    out.writeUInt16LE(colors.length / 4, 4)
    colors.copy(out, 6)
    return out
  }
  private restore(device: Device): void {
    if (!device.controlled) return
    this.send(1050, device.id, this.colorPacket(device.colors))
    if (device.modeData) {
      const payload = Buffer.concat([
        u32(8 + device.modeData.length),
        u32(device.mode),
        device.modeData
      ])
      this.send(1101, device.id, payload)
    }
    device.controlled = false
  }
  apply(hex: string): void {
    if (!this.ready) return
    const s = getSettings(),
      selected = s.argbDevices
    const rgb = [1, 3, 5].map((i) =>
      Math.round(parseInt(hex.slice(i, i + 2), 16) * s.argbBrightness)
    )
    for (const device of this.devices) {
      if (!selected.includes('*') && !selected.includes(device.key)) {
        this.restore(device)
        continue
      }
      if (!device.leds) continue
      if (!device.controlled) {
        this.send(1100, device.id)
        device.controlled = true
      }
      const colors = Buffer.alloc(device.leds * 4)
      for (let i = 0; i < device.leds; i++) {
        colors[i * 4] = rgb[0]!
        colors[i * 4 + 1] = rgb[1]!
        colors[i * 4 + 2] = rgb[2]!
      }
      this.send(1050, device.id, this.colorPacket(colors))
    }
  }
  close(): void {
    for (const d of this.devices) this.restore(d)
    this.ready = false
    this.socket?.end()
    this.socket = null
  }
}
let client: OpenRgb | null = null,
  color = '#8476ff',
  currentColor = color,
  timer: NodeJS.Timeout | null = null,
  connecting = false,
  lastTry = 0,
  config = ''
export function setLightingColor(hex: string): void {
  if (!/^#[a-f\d]{6}$/i.test(hex)) return
  if (hex.toLowerCase() === color.toLowerCase()) return
  const from = [1, 3, 5].map((i) => parseInt(currentColor.slice(i, i + 2), 16)),
    to = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    start = Date.now()
  color = hex
  if (timer) clearTimeout(timer)
  const step = (): void => {
    const t = Math.min(1, (Date.now() - start) / 850),
      k = t * t * (3 - 2 * t)
    currentColor =
      '#' +
      to
        .map((v, i) =>
          Math.round(from[i]! + (v - from[i]!) * k)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    client?.apply(currentColor)
    timer = t < 1 ? setTimeout(step, 33) : null
  }
  step()
}
export function getLightingAccent(): string {
  return color
}
export function syncLighting(): void {
  const s = getSettings(),
    next = JSON.stringify([s.argbEnabled, s.argbPort, s.argbBrightness, s.argbDevices])
  if (!s.argbEnabled) {
    client?.close()
    client = null
    config = next
    return
  }
  if (client?.ready && next === config) return
  if (client?.ready && s.argbPort === Number(config && JSON.parse(config)[1])) {
    config = next
    client.apply(currentColor)
    return
  }
  if (connecting || Date.now() - lastTry < 5000) return
  client?.close()
  client = new OpenRgb()
  connecting = true
  lastTry = Date.now()
  config = next
  const current = client
  void current
    .connect(s.argbPort)
    .then(() => {
      if (current === client && getSettings().argbEnabled) current.apply(currentColor)
      else current.close()
    })
    .catch((e) => {
      current.error = String(e)
      current.socket?.destroy()
    })
    .finally(() => {
      connecting = false
    })
}
export function lightingStatus(): LightingStatus {
  syncLighting()
  return {
    connected: client?.ready ?? false,
    message: client?.ready
      ? `OpenRGB 已连接 · ${client.devices.length} 个设备`
      : connecting
        ? '正在连接 OpenRGB…'
        : getSettings().argbEnabled
          ? client?.error || '请在 OpenRGB 启用 SDK 服务（127.0.0.1）'
          : '灯光联动已关闭',
    devices: client?.devices.map(({ key, name, leds }) => ({ key, name, leds })) ?? []
  }
}
export function closeLighting(): void {
  if (timer) clearTimeout(timer)
  client?.close()
  client = null
}
