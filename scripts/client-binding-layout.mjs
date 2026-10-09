import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { browserConcurrency, runBrowserCases, selectBrowserCases } from './browser-case-runner.mjs'
import { npmCliCommand } from './npm-cli.mjs'
import { assertControlVisual, assertVisualSurface, controlAppearance, setFixtureTheme } from './client-visual-contract.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' }, 'fixtures-dir': { type: 'string' }, concurrency: { type: 'string' }, case: { type: 'string', multiple: true }, list: { type: 'boolean' }, focus: { type: 'boolean' } } })
const matrix = [320, 390, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })))
const cardStates = ['ready-en', 'ready-zh', 'saved-en', 'saved-zh', 'kinds-en', 'kinds-zh',
  ...['en', 'zh'].flatMap(locale => ['unavailable', 'session', 'global'].map(tab => `popover-${tab}-${locale}`))]
const surfaceStates = ['console-en', 'console-zh', 'workbench-en', 'workbench-zh', 'modal-en', 'modal-zh',
  'empty-en', 'empty-zh', 'settings-en', 'settings-zh', 'settings-page-en', 'settings-page-zh', 'settings-dialog-en', 'settings-dialog-zh', 'prompt-edit-en', 'prompt-edit-zh']
const allCases = matrix.flatMap(({ width, theme }) => [...cardStates, ...surfaceStates]
  .map(state => ({ id: `${width}/${theme}/${state}`, width, theme, state })))
const cases = selectBrowserCases(allCases, values.case, values)
const focused = cases.length !== allCases.length
const concurrency = browserConcurrency(values.concurrency)
if (values.list) {
  console.log(cases.map(item => item.id).join('\n'))
} else {
  const started = performance.now()
  const output = resolve('artifacts/binding-layout')
  await mkdir(output, { recursive: true })
  const fixtureArgument = values['fixtures-dir']?.trim()
  const ownedDirectory = !fixtureArgument
  const directory = fixtureArgument ? resolve(fixtureArgument) : await mkdtemp(resolve(output, 'candidate-'))
  try {
    if (ownedDirectory) {
      const command = npmCliCommand(['run', 'test:client:fixtures'])
      await new Promise((resolveRun, reject) => {
        const child = spawn(command.executable, command.args, {
          env: { ...process.env, PTC_BINDING_UI_FIXTURE: directory }, stdio: 'inherit', windowsHide: true,
        })
        child.on('error', reject)
        child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Client fixture exited ${code}`)))
      })
    }
    console.log(`Binding layout: ${cases.length}/${allCases.length} cases, ${concurrency} isolated browsers`)
    const measurements = await runBrowserCases(cases, async (page, { width, theme, state }) => {
      await page.setViewportSize({ width, height: 900 })
      if (cardStates.includes(state)) {
        await page.goto(pathToFileURL(resolve(directory, `${state}.html`)).href)
        await setFixtureTheme(page, theme)
        const visualControls = await assertVisualSurface(page, page.locator('body'), `${width}/${theme}/${state}`)
        if (state.startsWith('kinds-')) {
          for (const control of await page.locator('.ptcPlusReplBindingTrigger').all()) {
            await assertControlVisual(control, { hover: true, label: `${theme}/REPL name kind` })
          }
        }
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
            if (button !== undefined && text.right > button.left + 1) collisions.push({ text, button })
          }
          const containers = [...document.querySelectorAll('.fixture,.ptcPlusGlobalList,.ptcPlusBindingCommand')]
            .map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth }))
          const buttons = [...document.querySelectorAll('button')].map(element => ({
            text: element.textContent, bounds: bounds(element), owner: bounds(element.parentElement),
            action: element.closest('.ptcPlusGlobalItem,.ptcPlusBindingCommandActions,.ptcPlusReplTabs') !== null,
          }))
          const head = document.querySelector('.ptcPlusReplHead')
          const headBounds = head === null ? null : bounds(head)
          const header = head === null ? null : { height: headBounds.height,
            titleOffset: bounds(head.querySelector('.ptcPlusReplTitle')).top - headBounds.top,
            dotOffset: bounds(head.querySelector('.ptcPlusReplStatusDot')).top - headBounds.top,
            tabsOffset: bounds(document.querySelector('.ptcPlusReplTabs')).top - headBounds.top }
          return { collisions, containers, buttons, header, pageWidth: document.documentElement.scrollWidth,
            tabFont: document.querySelector('.ptcPlusReplTab') === null
              ? null : getComputedStyle(document.querySelector('.ptcPlusReplTab')).fontSize }
        })
        assert.deepEqual(metrics.collisions, [], `${width}/${state}: overlapping list actions`)
        assert.ok(metrics.containers.every(item => item.scroll <= item.client + 1), JSON.stringify(metrics.containers))
        assert.ok(metrics.pageWidth <= width, `${width}/${state}: viewport overflow`)
        if (state.startsWith('popover-')) assert.equal(metrics.tabFont, '11px')
        for (const { text, bounds, owner, action } of metrics.buttons) {
          assert.ok(bounds.width > 0 && bounds.height >= (action ? 24 : 16), `${state}: unusable button ${text}`)
          assert.ok(bounds.left >= owner.left - 1 && bounds.right <= owner.right + 1, `${state}: button outside owner ${text}`)
        }
        await summary.focus()
        await page.keyboard.press('Enter')
        assert.equal(await details.getAttribute('open'), null)
        const collapsedHeight = await page.locator('.ptcPlusBindingCommand').evaluate(element => element.clientHeight)
        if (state.startsWith('saved')) assert.ok(collapsedHeight < 230, `loose saved card: ${collapsedHeight}px`)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-${state}-collapsed.png`), fullPage: true })
        await page.keyboard.press('Enter')
        await page.screenshot({ path: resolve(output, `${width}-${theme}-${state}-source.png`), fullPage: true })
        return { width, theme, state, visualControls, collapsedHeight, ...metrics }
      }
        await page.goto(pathToFileURL(resolve(directory, `${state}.html`)).href)
        await setFixtureTheme(page, theme)
        const visualControls = await assertVisualSurface(page, page.locator('body'), `${width}/${theme}/${state}`)
        if (state === 'workbench-en' && width === 320) {
          const toggle = page.locator('.ptcPlusBindingSwitch').first()
          const normal = await controlAppearance(toggle)
          assert.equal(normal.officialSwitch, true, 'binding switch differs from official appearance')
          const fault = await page.addStyleTag({ content: '.ptcPlusBindingSwitch span{background-color:inherit!important}' })
          try {
            const unreadable = await controlAppearance(toggle)
            assert.ok(Number.isFinite(unreadable.minContrast) && unreadable.minContrast < 3, 'binding thumb contrast was not measured')
            await assert.rejects(() => assertControlVisual(toggle, { focus: false }), /unreadable control|official switch appearance lost/)
          } finally { await fault.evaluate(element => element.remove()) }
          await assertControlVisual(toggle)
          const checked = await toggle.getAttribute('aria-checked')
          await toggle.evaluate(element => element.setAttribute('aria-checked', 'false'))
          try { await assertControlVisual(toggle) }
          finally { await toggle.evaluate((element, checked) => element.setAttribute('aria-checked', checked), checked) }
        }
        if (state === 'settings-dialog-en' && theme === 'dark' && width === 320) {
          const toggle = page.locator('.ptcPlusSettingsTitleSwitch input')
          const fault = await page.addStyleTag({ content: '.ptcPlusSettingsTitleSwitch input::before{background:var(--dsw-alias-brand-primary)!important}' })
          try {
            await assert.rejects(() => assertControlVisual(toggle, { focus: false }), /unreadable control/)
          } finally {
            await fault.evaluate(element => element.remove())
          }
        }
        for (const item of await page.locator('.ptcPlusSettingsNavItem').all()) {
          await assertControlVisual(item, { hover: true, label: `${width}/${theme}/${state}/section navigation` })
        }
        const metrics = await page.evaluate(() => {
          const containers = [...document.querySelectorAll('.ptcPlusConsole,.ptcPlusBindingsSurface,.ptcPlusBindingsDialog,.ptcPlusBindingEditor,.ptcPlusSettingsDialog,.ptcPlusSettingsDialogContent,.ptcPlusCapabilityList')]
            .map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth }))
          const collisions = []
          for (const row of document.querySelectorAll('.ptcPlusBindingItem')) {
            const [text, action] = [...row.children].map(element => element.getBoundingClientRect())
            if (text.right > action.left + 1) collisions.push(row.textContent)
          }
          for (const row of document.querySelectorAll('.ptcPlusCapabilityItem')) {
            const rectangles = [...row.children].map(element => element.getBoundingClientRect())
            for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
              const a = rectangles[i], b = rectangles[j]
              if (Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1
                && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1) collisions.push(row.textContent)
            }
          }
          const controls = [...document.querySelectorAll('button,input,textarea,select,summary')]
            .filter(element => {
              const style = getComputedStyle(element)
              return element.getClientRects().length > 0 && style.visibility !== 'hidden'
                && style.display !== 'none' && !element.closest('[aria-hidden=true],[hidden]')
            })
            .map(element => {
              const { left, right, width, height } = element.getBoundingClientRect()
              return { label: element.getAttribute('aria-label') ?? element.textContent, left, right, width, height, navigation: element.matches('.ptcPlusSettingsNavItem') }
            })
          const settingsDialog = document.querySelector('.ptcPlusSettingsModal')
          const settingsDialogBounds = settingsDialog === null ? null : settingsDialog.getBoundingClientRect()
          const settingsLayout = document.querySelector('.ptcPlusSettingsDialog .ptcPlusSettingsLayout')
          const settingsColumns = settingsLayout === null ? null : [...settingsLayout.children].map(element => {
            const { left, right, top, width } = element.getBoundingClientRect()
            return { left, right, top, width }
          })
          const settingsHead = document.querySelector('.ptcPlusSettingsDialogHead')?.getBoundingClientRect()
          return { containers, collisions, controls, pageWidth: document.documentElement.scrollWidth,
            settingsColumns,
            settingsDialog: settingsDialogBounds === null ? null : {
              top: settingsDialogBounds.top, bottom: settingsDialogBounds.bottom, height: settingsDialogBounds.height,
              width: settingsDialogBounds.width, headTop: settingsHead?.top, headBottom: settingsHead?.bottom,
            } }
        })
        assert.ok(metrics.pageWidth <= width, `${width}/${state}: viewport overflow`)
        assert.ok(metrics.containers.every(item => item.scroll <= item.client + 1), `${width}/${state}: ${JSON.stringify(metrics.containers)}`)
        assert.deepEqual(metrics.collisions, [], `${width}/${state}: overlapping binding actions`)
        assert.ok(metrics.controls.filter(item => !item.navigation).every(item => item.width > 0 && item.height >= 16 && item.left >= 0 && item.right <= width), `${width}/${state}: controls outside viewport ${JSON.stringify(metrics.controls.filter(item => !item.navigation && (item.width <= 0 || item.height < 16 || item.left < 0 || item.right > width)))}`)
        if (state.startsWith('settings-dialog-')) {
          assert.ok(metrics.settingsDialog !== null, `${width}/${state}: settings dialog missing`)
          assert.ok(metrics.settingsDialog.top >= 0 && metrics.settingsDialog.bottom <= 900,
            `${width}/${state}: settings dialog outside viewport`)
          assert.ok(metrics.settingsDialog.headTop >= metrics.settingsDialog.top
            && metrics.settingsDialog.headBottom <= metrics.settingsDialog.bottom,
          `${width}/${state}: fixed settings header lost`)
          assert.equal(metrics.settingsColumns.length, 2, `${width}/${state}: settings navigation or content missing`)
          const [navigation, content] = metrics.settingsColumns
          if (width === 1440) {
            assert.ok(metrics.settingsDialog.width >= 1000, `${width}/${state}: settings dialog remained narrow`)
            assert.ok(navigation.right < content.left && content.width > navigation.width,
              `${width}/${state}: navigation and form did not form two columns`)
          } else assert.ok(Math.abs(navigation.left - content.left) <= 1,
            `${width}/${state}: narrow settings did not stack`)
        }
        if (state.startsWith('settings')) {
          const list = page.locator('.ptcPlusCapabilityList')
          assert.equal(await list.locator('.ptcPlusCapabilityItem').count(), 48)
          assert.equal(await page.locator('.ptcPlusCapabilityChoices textarea,.ptcPlusCapabilityStatistics textarea').count(), 0)
          const first = list.locator('input[type=checkbox]').first()
          const last = list.getByRole('combobox').last()
          for (const control of [last, first]) {
            await control.focus()
            const reachable = await control.evaluate(element => {
              const rect = element.getBoundingClientRect(), clip = element.closest('.ptcPlusCapabilityList').getBoundingClientRect()
              const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
              return y >= clip.top && y <= clip.bottom && document.elementFromPoint(x, y) === element
            })
            assert.ok(reachable, `${width}/${state}: capability choice is not reachable after scrolling`)
          }
        }
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
        if (state.startsWith('settings')) await page.locator('.ptcPlusSettingsNavList').evaluateAll(elements => { for (const element of elements) element.scrollLeft = 0 })
        if (state.startsWith('settings-dialog-')) await page.locator('.ptcPlusSettingsDialog .ptcPlusFields')
          .evaluate(element => { element.scrollTop = 0 })
        await page.screenshot({ path: resolve(output, `${width}-${theme}-${state}.png`), fullPage: true })
        if (state.startsWith('settings-dialog-')) {
          await page.evaluate(() => document.documentElement.style.setProperty('--dsh-frame-overlay-top', '64px'))
          for (const height of [900, 240]) {
            await page.setViewportSize({ width, height })
            const inset = await page.locator('.ptcPlusSettingsModal').evaluate(element => {
              const dialog = element.getBoundingClientRect(), overlay = element.parentElement.getBoundingClientRect()
              const padding = getComputedStyle(element.parentElement)
              const button = element.querySelector('.ptcPlusSettingsDialogHead button')
              const close = button.getBoundingClientRect()
              return { top: dialog.top, bottom: dialog.bottom,
                allowedTop: overlay.top + parseFloat(padding.paddingTop),
                allowedBottom: overlay.bottom - parseFloat(padding.paddingBottom),
                closeReachable: document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2) === button }
            })
            assert.ok(inset.top >= inset.allowedTop - 1 && inset.bottom <= inset.allowedBottom + 1,
              `${width}x${height}/${state}: settings dialog crossed Host overlay insets ${JSON.stringify(inset)}`)
            assert.equal(inset.closeReachable, true, `${width}x${height}/${state}: settings close action is covered`)
          }
        }
        return { width, theme, state, visualControls, ...metrics }
    }, { concurrency, channel: values['browser-channel'] })
    for (const { width, theme } of matrix) for (const locale of ['en', 'zh']) {
      const headers = measurements.filter(item => item.width === width
        && item.theme === theme && item.state.startsWith('popover-') && item.state.endsWith(locale)).map(item => item.header)
      if (focused && headers.length !== 3) continue
      assert.equal(headers.length, 3)
      assert.deepEqual(headers[0], headers[1], `${width}/${locale}: header shifts when session data becomes available`)
      assert.deepEqual(headers[1], headers[2], `${width}/${locale}: header shifts between Session and Global`)
    }
    const covered = new Set(measurements.flatMap(item => item.visualControls))
    if (!focused) for (const name of ['action', 'settings disclosure', 'binding selection', 'binding switch', 'icon command',
      'input', 'instructions', 'settings switch', 'settings navigation', 'settings close', 'select', 'search', 'REPL observation', 'REPL definition', 'REPL tab', 'source disclosure']) {
      assert.ok(covered.has(name), `Visual fixture lost responsibility: ${name}`)
    }
    await writeFile(resolve(output, focused ? 'measurements-focused.json' : 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
    console.log(`${focused ? 'Focused binding layout' : 'Binding layout'} passed: ${measurements.length} viewport/state combinations`)
  } finally {
    if (ownedDirectory) await rm(directory, { recursive: true, force: true })
    console.log(`Binding layout completed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
  }
}
