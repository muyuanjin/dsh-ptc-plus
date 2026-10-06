import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { runBrowserCases } from './browser-case-runner.mjs'
import { settleVisual } from './client-visual-contract.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' } } })
const cases = [{ id: 'unanimated' }, { id: 'cancel-event-replacement' }, { id: 'pending-and-infinite' }, { id: 'deadline' }]
await runBrowserCases(cases, async (page, { id }) => {
  await page.goto('about:blank')
  await page.setContent('<style>#probe{opacity:1;transition:opacity 200ms linear}</style><div id="probe">Probe</div>')
  if (id === 'unanimated') {
    await page.evaluate(() => {
      window.framesRequested = 0
      const frame = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = callback => { window.framesRequested += 1; return frame(callback) }
    })
    await settleVisual(page)
    assert.equal(await page.evaluate(() => window.framesRequested), 0, 'unanimated styles paid an empty frame wait')
  } else if (id === 'cancel-event-replacement') {
    await page.evaluate(() => {
      const element = document.querySelector('#probe')
      void getComputedStyle(element).opacity
      element.addEventListener('transitioncancel', () => {
        window.replaced = true
        element.style.transition = 'opacity 150ms linear'
        element.style.opacity = '1'
      }, { once: true })
      element.style.opacity = '0'
      void getComputedStyle(element).opacity
      setTimeout(() => {
        element.style.transition = 'none'
        element.style.opacity = '0.25'
        void getComputedStyle(element).opacity
      }, 30)
    })
    await settleVisual(page)
    assert.equal(await page.evaluate(() => window.replaced), true, 'cancellation event was not dispatched before settlement')
    assert.equal(await page.locator('#probe').evaluate(element => getComputedStyle(element).opacity), '1',
      'replacement transition destination was not reached')
  } else if (id === 'pending-and-infinite') {
    await page.evaluate(() => {
      const element = document.querySelector('#probe')
      window.infinite = element.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(1px)' }],
        { duration: 1000, iterations: Infinity })
      window.finite = element.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 100, delay: 50, fill: 'forwards' })
    })
    await settleVisual(page)
    assert.equal(await page.evaluate(() => window.finite.playState), 'finished')
    assert.equal(await page.evaluate(() => window.infinite.playState), 'running')
    assert.equal(await page.locator('#probe').evaluate(element => getComputedStyle(element).opacity), '0.5')
  } else {
    await page.evaluate(() => document.querySelector('#probe').animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 2000 }))
    await assert.rejects(settleVisual(page), /did not settle within 500 ms/)
  }
}, { concurrency: 1, channel: values['browser-channel'] })
console.log('Visual settlement passed: empty styles, queued cancellation replacements, finite/infinite work and bounded failure')
