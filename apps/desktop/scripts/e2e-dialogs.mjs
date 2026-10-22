import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { resolve, join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  out = join(tmpdir(), 'jap-dialog-qa')
mkdirSync(out, { recursive: true })
const wav = join(out, 'QA.wav'),
  b = Buffer.alloc(44 + 48000 * 4)
b.write('RIFF')
b.writeUInt32LE(b.length - 8, 4)
b.write('WAVEfmt ', 8)
b.writeUInt32LE(16, 16)
b.writeUInt16LE(1, 20)
b.writeUInt16LE(2, 22)
b.writeUInt32LE(48000, 24)
b.writeUInt32LE(192000, 28)
b.writeUInt16LE(4, 32)
b.writeUInt16LE(16, 34)
b.write('data', 36)
b.writeUInt32LE(b.length - 44, 40)
writeFileSync(wav, b)
const app = await electron.launch({
  executablePath: electronPath,
  cwd,
  args: ['.', '--no-sandbox', ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'dialogs' },
})
const errors = [],
  report = { checks: [] }
let page
try {
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', async (d) => {
    errors.push('Unexpected native dialog: ' + d.message())
    await d.dismiss()
  })
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate(() => {
    __jap.useSettings.getState().update({ autoScan: false, onboardingComplete: true })
    __jap.useUi.getState().setOnboardingOpen(false)
  })
  await page.getByRole('button', { name: '打开文件', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '选择音频文件', exact: true })
  await modal.waitFor()
  assert.ok(await page.evaluate(() => document.getElementById('root').inert))
  await page.getByLabel('文件夹路径', { exact: true }).fill(out)
  await page.getByLabel('文件夹路径', { exact: true }).press('Enter')
  await modal.getByRole('option').filter({ hasText: 'QA.wav' }).click()
  await modal.getByRole('button', { name: '打开', exact: true }).click()
  await modal.waitFor({ state: 'detached' })
  await page.waitForFunction(
    (path) => __jap.useLibrary.getState().lists.some((l) => l.items.some((i) => i.path === path)),
    wav
  )
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), false)
  report.checks.push('Import via styled browser, root inert/focus restored')
  await page.evaluate(() => {
    window.__save = window.jap.pickExportPath('QA List.json', true)
    return true
  })
  await page.getByRole('dialog').waitFor()
  await page.getByLabel('文件夹路径', { exact: true }).fill(out)
  await page.getByLabel('文件夹路径', { exact: true }).press('Enter')
  await page.getByLabel('保存文件名', { exact: true }).fill('QA List.json')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  if (await page.getByRole('button', { name: '确认替换', exact: true }).count())
    await page.getByRole('button', { name: '确认替换', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  const target = await page.evaluate(() => window.__save)
  assert.equal(target.replaceAll('\\', '/'), join(out, 'QA List.json').replaceAll('\\', '/'))
  await page.evaluate(async (path) => window.jap.writeExport(path, '{"ok":true}'), target)
  assert.equal(readFileSync(target, 'utf8'), '{"ok":true}')
  report.checks.push('Save/export and overwrite confirmation')
  await page.evaluate(() => __jap.useUi.getState().togglePanel('appearance'))
  await page.getByRole('button', { name: '自定义强调色', exact: true }).click()
  await page.getByLabel('自定义颜色值', { exact: true }).fill('#3574cb')
  await page.getByRole('button', { name: '使用这束颜色', exact: true }).click()
  await page.waitForFunction(() => __jap.useSettings.getState().accent === '#3574cb')
  assert.ok(await page.locator('[data-panel-root="appearance"]').count())
  report.checks.push('Styled color picker preserves settings panel')
  await page.evaluate(() => __jap.useUi.getState().togglePanel('dsp'))
  await page.getByLabel('音效预置', { exact: true }).click()
  await page.getByRole('option', { name: '温暖', exact: true }).click()
  assert.ok(await page.locator('[data-panel-root="dsp"]').count())
  report.checks.push('Styled listbox remains inside parent card interaction')
  await page.evaluate(() => {
    __jap.useLibrary.getState().createList('Modal QA')
    __jap.useUi.getState().togglePanel('playlist')
  })
  await page.getByRole('button', { name: '删除列表', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: '保留', exact: true }).click()
  assert.ok(await page.locator('[data-panel-root="playlist"]').count())
  report.checks.push('Destructive action uses themed confirmation')
  assert.equal(await page.locator('select,input[type="color"],input[type="checkbox"]').count(), 0)
  await app.evaluate(({ dialog }) => {
    globalThis.__nativeDialogOriginal = dialog.showOpenDialog
    globalThis.__nativeDialogCalls = 0
    dialog.showOpenDialog = async () => {
      globalThis.__nativeDialogCalls++
      return { canceled: true, filePaths: [] }
    }
  })
  try {
    await page.evaluate(() => window.jap.setWindowMode('mini'))
    assert.deepEqual(await page.evaluate(() => window.jap.openAudioFiles()), [])
    assert.equal(await app.evaluate(() => globalThis.__nativeDialogCalls), 1)
    report.checks.push('Mini player audio import uses the native OS file chooser')
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__nativeDialogOriginal
    })
    await page.evaluate(() => window.jap.setWindowMode('normal'))
  }
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(out, 'dialogs.png') })
  report.ok = true
  console.log(JSON.stringify(report))
} finally {
  await app.close()
}
