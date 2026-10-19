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
