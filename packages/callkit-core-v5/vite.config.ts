import { defineConfig } from 'vite'
import { resolve } from 'path'
import pkg from './package.json'

export default defineConfig({
  define: {
    __CALLKIT_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'EaseMobCallKitCoreV5',
      fileName: (format) => {
        switch (format) {
          case 'es':
            return 'index.js'
          case 'cjs':
            return 'index.cjs'
          case 'umd':
            return 'index.umd.js'
          case 'iife':
            return 'index.iife.js'
          default:
            return `index.${format}.js`
        }
      },
      formats: ['es', 'cjs', 'umd', 'iife'],
    },
    rollupOptions: {
      // 外部依赖：peerDependencies 和 devDependencies 不打入包内
      external: ['easemob-websdk'],
      output: {
        globals: {
          'easemob-websdk': 'Easemob',
        },
      },
    },
    outDir: 'dist',
    sourcemap: true,
    // 构建环境可能禁止删除目录；声明产物由 tsc 覆盖写入，无需清空
    emptyOutDir: false,
    // es/cjs 保持未压缩（便于调试和 tree-shaking），umd/iife 在 fileName 中通过 .min.js 区分压缩版本
    minify: false,
  },
  // 类型声明由 tsc -p tsconfig.build.json 产出（见 package.json 的 build 脚本）
})
