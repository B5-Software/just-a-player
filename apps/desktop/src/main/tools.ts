import { delimiter } from 'node:path'
import { existsSync } from 'node:fs'
/** GUI launches on macOS do not inherit the user's shell Homebrew PATH. */
export function discoverAudioTools(): void {
  const extras =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin']
        : []
  process.env.PATH = [...(process.env.PATH ?? '').split(delimiter), ...extras.filter(existsSync)]
    .filter((p, i, a) => p && a.indexOf(p) === i)
    .join(delimiter)
}
