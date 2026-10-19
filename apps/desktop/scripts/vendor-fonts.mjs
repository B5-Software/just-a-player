// 把歌词与界面用到的 OFL 字体从 @fontsource 包里取出来，本地化到渲染层。
// 只保留 woff2（Fontsource 的 CSS 同时引用了 woff，会让打包体积翻倍），并把许可证一起复制过去。
// 用法：pnpm --filter desktop fonts:vendor
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(fileURLToPath(import.meta.url), '../..')
const pkgRoot = join(appDir, 'node_modules/@fontsource')
const outDir = join(appDir, 'src/renderer/src/fonts')
const publicLicenses = join(appDir, 'src/renderer/public/licenses/fonts')

const SPECS = [
  {
    pkg: 'noto-sans-sc',
    subsets: ['chinese-simplified-400', 'chinese-simplified-700', 'latin-400', 'latin-700']
  },
  { pkg: 'noto-serif-sc', subsets: ['chinese-simplified-700', 'latin-700'] },
  { pkg: 'lxgw-wenkai', subsets: ['latin-500'] },
  { pkg: 'zcool-kuaile', subsets: ['chinese-simplified-400', 'latin-400'] },
  { pkg: 'ma-shan-zheng', subsets: ['chinese-simplified-400', 'latin-400'] },
  ...['long-cang', 'zhi-mang-xing', 'liu-jian-mao-cao', 'zcool-xiaowei', 'zcool-qingke-huangyou']
    .map((pkg) => ({ pkg, subsets: ['chinese-simplified-400', 'latin-400'] })),
  { pkg: 'noto-sans-mono', subsets: ['latin-400', 'latin-700'] }
]

mkdirSync(join(outDir, 'licenses'), { recursive: true })
mkdirSync(publicLicenses, { recursive: true })

const blocks = []
for (const { pkg, subsets } of SPECS) {
  copyFileSync(join(pkgRoot, pkg, 'LICENSE'), join(outDir, 'licenses', `${pkg}.OFL.txt`))
  copyFileSync(join(pkgRoot, pkg, 'LICENSE'), join(publicLicenses, `${pkg}.OFL.txt`))
  for (const subset of subsets) {
    const css = readFileSync(join(pkgRoot, pkg, `${subset}.css`), 'utf8')
    const fontBlocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? []
    for (const block of fontBlocks) {
      const file = /url\(\.\/files\/([^)]+)\.woff2\)/.exec(block)?.[1]
      if (!file) throw new Error(`${pkg}/${subset}: 找不到 woff2 文件`)
      copyFileSync(join(pkgRoot, pkg, 'files', `${file}.woff2`), join(outDir, `${file}.woff2`))
      const local = block.replace(/src:[^;]*;/, `src: url(./${file}.woff2) format('woff2');`)
      blocks.push(`/* ${pkg} · ${subset} */\n${local}`)
    }
  }
}

writeFileSync(
  join(outDir, 'fonts.css'),
  `/* 本地化的 OFL 字体，由 scripts/vendor-fonts.mjs 生成，请勿手改。 */\n${blocks.join('\n')}\n`
)
console.log(`fonts: ${blocks.length} 个字体面 -> ${outDir}`)
