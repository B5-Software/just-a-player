export interface GpuAdapter {
  id: string
  name: string
  luid: string
  memoryMb: number
}
export interface GpuInfo {
  adapters: GpuAdapter[]
  selected: string
  current: string
  error: string | null
}
