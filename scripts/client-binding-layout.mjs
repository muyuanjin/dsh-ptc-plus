import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { npmCliCommand } from './npm-cli.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' } } })
const directory = resolve('artifacts/binding-layout')
await mkdir(directory, { recursive: true })
const command = npmCliCommand(['run', 'test:client'])
await new Promise((resolveRun, reject) => {
  const child = spawn(command.executable, command.args, {
    env: { ...process.env, PTC_BINDING_UI_FIXTURE: directory }, stdio: 'inherit', windowsHide: true,
  })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Client fixture exited ${code}`)))
})
const browser = await chromium.launch({ headless: true, channel: values['browser-channel'] })
const measurements = []
try {
  const page = await browser.newPage()
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const state of ['ready-en', 'ready-zh', 'saved-en', 'saved-zh']) {
      await page.goto(pathToFileURL(resolve(directory, `${state}.html`)).href)
      const details = page.locator('.ptcPlusBindingSourceDetails')
      const summary = details.locator('summary')
      await summary.focus()
      if (!await details.getAttribute('open').then(value => value !== null)) await page.keyboard.press('Enter')
      assert.equal(await details.getAttribute('open'), '')
      assert.match(await details.innerText(), /export const value = 42/)
      const metrics = await page.evaluate(() => {
        const bounds = element => {
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
          return { left, right, top, bottom, width, height }
        }
        const collisions = []
        for (const row of document.querySelectorAll('.ptcPlusGlobalItem')) {
          const [text, button] = [...row.children].map(bounds)
          if (text.right > button.left + 1) collisions.push({ text, button })
        }
        const containers = [...document.querySelectorAll('.fixture,.ptcPlusGlobalList,.ptcPlusBindingCommand')]
          .map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth }))
        const buttons = [...document.querySelectorAll('button')].map(element => ({
          text: element.textContent, bounds: bounds(element), owner: bounds(element.parentElement),
          action: element.closest('.ptcPlusGlobalItem,.ptcPlusBindingCommandActions,.ptcPlusReplTabs') !== null,
        }))
        return { collisions, containers, buttons, pageWidth: document.documentElement.scrollWidth,
          tabFont: getComputedStyle(document.querySelector('.ptcPlusReplTab')).fontSize }
      })
      assert.deepEqual(metrics.collisions, [], `${width}/${state}: overlapping list actions`)
      assert.ok(metrics.containers.every(item => item.scroll <= item.client + 1), JSON.stringify(metrics.containers))
      assert.ok(metrics.pageWidth <= width, `${width}/${state}: viewport overflow`)
      assert.equal(metrics.tabFont, '11px')
      for (const { text, bounds, owner, action } of metrics.buttons) {
        assert.ok(bounds.width > 0 && bounds.height >= (action ? 24 : 16), `${state}: unusable button ${text}`)
        assert.ok(bounds.left >= owner.left - 1 && bounds.right <= owner.right + 1, `${state}: button outside owner ${text}`)
      }
      await page.keyboard.press('Enter')
      assert.equal(await details.getAttribute('open'), null)
      const collapsedHeight = await page.locator('.ptcPlusBindingCommand').evaluate(element => element.clientHeight)
      if (state.startsWith('saved')) assert.ok(collapsedHeight < 230, `loose saved card: ${collapsedHeight}px`)
      await page.screenshot({ path: resolve(directory, `${width}-${state}-collapsed.png`), fullPage: true })
      await page.keyboard.press('Enter')
      await page.screenshot({ path: resolve(directory, `${width}-${state}-source.png`), fullPage: true })
      measurements.push({ width, state, collapsedHeight, ...metrics })
    }
  }
  await writeFile(resolve(directory, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  console.log(`Binding layout passed: ${measurements.length} viewport/state combinations`)
} finally {
  await browser.close()
}
