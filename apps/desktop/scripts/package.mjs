import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const cwd = fileURLToPath(new URL('..', import.meta.url))
const flavor = process.env.JAP_BUNDLE_MIDI === '0' ? 'without-midi' : 'with-midi'
const config = join(cwd, 'build/package-variant.json')
writeFileSync(
  config,
  JSON.stringify(
    {
      extends: 'electron-builder.yml',
      extraResources: [
        {
          from: '../../assets/soundfonts',
          to: 'soundfonts',
          filter: [
            ...(flavor === 'with-midi' ? ['MuseScore_General_HQ.sf2'] : []),
            'documentation/**',
          ],
        },
        { from: 'build/notices', to: 'licenses' },
        { from: 'build/media-tools', to: 'media-tools' },
        { from: 'build/lightweight', to: 'lightweight' },
      ],
      win: { artifactName: 'Just-A-Player-${version}-win-${arch}-' + flavor + '.${ext}' },
      mac: { artifactName: 'Just-A-Player-${version}-mac-${arch}-' + flavor + '.${ext}' },
      linux: { artifactName: 'Just-A-Player-${version}-linux-${arch}-' + flavor + '.${ext}' },
    },
    null,
    2
  )
)
try {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'electron-builder', '--config', config, ...process.argv.slice(2)],
    { cwd, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' }
  )
  process.exitCode = result.status ?? 1
} finally {
  unlinkSync(config)
}
