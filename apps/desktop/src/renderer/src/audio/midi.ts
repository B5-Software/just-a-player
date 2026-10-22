import { engine } from '../engine/client'
import { useSettings } from '../settings/store'
/** Each playing source captures its bank; preference changes apply to the next MIDI. */
export function initMidi(): void {
  const sync = (): void => {
    const s = useSettings.getState()
    engine.send({
      type: 'setMidi',
      soundfont: s.midiSoundfont || null,
      sampleRate: s.midiSampleRate,
    })
  }
  engine.onConnect(sync)
  useSettings.subscribe((s, previous) => {
    if (s.midiSoundfont !== previous.midiSoundfont || s.midiSampleRate !== previous.midiSampleRate)
      sync()
  })
}
