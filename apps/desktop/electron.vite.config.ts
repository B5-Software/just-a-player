import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      lib: {
        // 第二个入口是跑 Rust 引擎的 utilityProcess，与主进程同目录输出
        entry: {
          index: resolve('src/main/index.ts'),
          'engine-host': resolve('src/utility/engine-host.ts')
        }
      }
    }
  },
  preload: {
    build: { lib: { entry: resolve('src/preload/index.ts') } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
