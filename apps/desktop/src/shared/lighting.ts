export interface LightingStatus {
  connected: boolean
  message: string
  devices: { key: string; name: string; leds: number }[]
}
