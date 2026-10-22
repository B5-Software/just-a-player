// Prevent cross-packaging a native app with another platform's generated tools.
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
module.exports = async (context) => {
  const platform = context.electronPlatformName
  const arch = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64' }[context.arch]
  const resources =
    platform === 'darwin'
      ? join(
          context.appOutDir,
          context.packager.appInfo.productFilename + '.app',
          'Contents/Resources'
        )
      : join(context.appOutDir, 'resources')
  const tools = join(resources, 'media-tools')
  const { statSync } = require('node:fs')
  const font = join(resources, 'soundfonts', 'MuseScore_General_HQ.sf2')
  if (
    process.env.JAP_BUNDLE_MIDI === '0'
      ? existsSync(font)
      : !existsSync(font) || statSync(font).size !== 489517354
  )
    throw new Error('Packaged MIDI bank does not match the requested variant')
  if (
    process.env.JAP_BUNDLE_MIDI !== '0' &&
    !existsSync(join(resources, 'soundfonts/documentation/MuseScore_General_HQ_License.md'))
  )
    throw new Error('Missing packaged MIDI soundfont license')
  const identity = JSON.parse(readFileSync(join(tools, 'bundle.json'), 'utf8'))
  if (identity.target !== `${platform}-${arch}`)
    throw new Error(
      `FFmpeg bundle ${identity.target} does not match ${platform}-${arch}; build on the target platform.`
    )
  for (const name of ['ffmpeg', 'ffprobe'])
    if (!existsSync(join(tools, 'bin', name + (platform === 'win32' ? '.exe' : ''))))
      throw new Error(`Missing packaged ${name}`)
  console.log(`Verified packaged media tools: ${identity.target}, helpers ${identity.binaryArch}`)
}
