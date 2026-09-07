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
    const states = ['ready-en', 'ready-zh', 'saved-en', 'saved-zh',
      ...['en', 'zh'].flatMap(locale => ['unavailable', 'session', 'global'].map(tab => `popover-${tab}-${locale}`))]
    for (const state of states) {
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
        const head = document.querySelector('.ptcPlusReplHead')
        const headBounds = bounds(head)
        const header = { height: headBounds.height,
          titleOffset: bounds(head.querySelector('.ptcPlusReplTitle')).top - headBounds.top,
          dotOffset: bounds(head.querySelector('.ptcPlusReplStatusDot')).top - headBounds.top,
          tabsOffset: bounds(document.querySelector('.ptcPlusReplTabs')).top - headBounds.top }
        return { collisions, containers, buttons, header, pageWidth: document.documentElement.scrollWidth,
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
    for (const locale of ['en', 'zh']) {
      const headers = measurements.filter(item => item.width === width
        && item.state.startsWith('popover-') && item.state.endsWith(locale)).map(item => item.header)
      assert.equal(headers.length, 3)
      assert.deepEqual(headers[0], headers[1], `${width}/${locale}: header shifts when session data becomes available`)
      assert.deepEqual(headers[1], headers[2], `${width}/${locale}: header shifts between Session and Global`)
    }
  }
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const state of ['console-en', 'console-zh', 'workbench-en', 'workbench-zh', 'modal-en', 'modal-zh', 'empty-en', 'empty-zh', 'settings-en', 'settings-zh', 'prompt-edit-en', 'prompt-edit-zh']) {
      await page.goto(pathToFileURL(resolve(directory, `${state}.html`)).href)
      const metrics = await page.evaluate(() => {
        const containers = [...document.querySelectorAll('.ptcPlusConsole,.ptcPlusBindingsSurface,.ptcPlusBindingsDialog,.ptcPlusBindingEditor')]
          .map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth }))
        const collisions = []
        for (const row of document.querySelectorAll('.ptcPlusBindingItem')) {
          const [text, action] = [...row.children].map(element => element.getBoundingClientRect())
          if (text.right > action.left + 1) collisions.push(row.textContent)
        }
        const controls = [...document.querySelectorAll('button,input,textarea,select,summary')]
          .filter(element => element.getClientRects().length > 0)
          .map(element => {
            const { left, right, width, height } = element.getBoundingClientRect()
            return { label: element.getAttribute('aria-label') ?? element.textContent, left, right, width, height }
          })
        return { containers, collisions, controls, pageWidth: document.documentElement.scrollWidth }
      })
      assert.ok(metrics.pageWidth <= width, `${width}/${state}: viewport overflow`)
      assert.ok(metrics.containers.every(item => item.scroll <= item.client + 1), `${width}/${state}: ${JSON.stringify(metrics.containers)}`)
      assert.deepEqual(metrics.collisions, [], `${width}/${state}: overlapping binding actions`)
      assert.ok(metrics.controls.every(item => item.width > 0 && item.height >= 16 && item.left >= 0 && item.right <= width), `${width}/${state}: controls outside viewport`)
      if (state.startsWith('empty')) {
        const empty = await page.locator('.ptcPlusSessionEmpty').evaluate(element => ({
          width: element.getBoundingClientRect().width,
          parent: element.parentElement.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }))
        assert.ok(Math.abs(empty.width - empty.parent) <= 1, `${width}/${state}: partial-width empty state`)
        assert.ok(empty.height <= 100, `${width}/${state}: oversized empty state`)
        assert.equal(await page.locator('.ptcPlusBindingInspector').count(), 0)
      }
      if (state.startsWith('console') || state.startsWith('workbench')) {
        assert.equal(await page.locator('.ptcPlusConsole [role=tab]').count(), 0)
        assert.equal(await page.locator('.ptcPlusSessionBindings').count(), 1)
        assert.equal(await page.locator('.ptcPlusConsole .ptcPlusBindings').count(), 1)
        assert.equal(await page.locator('.ptcPlusObservationCode').count(), 1)
      }
      await page.screenshot({ path: resolve(directory, `${width}-${state}.png`), fullPage: true })
      measurements.push({ width, state, ...metrics })
    }
  }
  await writeFile(resolve(directory, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  console.log(`Binding layout passed: ${measurements.length} viewport/state combinations`)
} finally {
  await browser.close()
}
