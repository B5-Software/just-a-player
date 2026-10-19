// Apple Silicon runners expose Metal; Intel macOS VMs need explicit SwANGLE.
export const graphicsArgs =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? []
    : [
        ...(process.platform === 'darwin' ? ['--use-gl=angle'] : []),
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
