import assert from 'node:assert/strict'

// Reference palettes exercise token consumers. The packed Host supplies its own themes.
export async function setFixtureTheme(page, theme) {
  await page.evaluate(theme => {
    const dark = theme === 'dark'
    const tokens = {
      'label-primary': dark ? '#eeeeef' : '#202124',
      'label-primary-dimmed': dark ? '#ccccce' : '#45464a',
      'label-secondary': dark ? '#babac0' : '#55565b',
      'label-tertiary': dark ? '#a0a0a8' : '#66676b',
      'label-dimmed': dark ? '#888890' : '#888990',
      'label-primary-foreground': dark ? '#17171a' : '#ffffff',
      'bg-base': dark ? '#17171a' : '#ffffff',
      'bg-layer-2': dark ? '#222226' : '#f6f7f8',
      'bg-layer-3': dark ? '#29292e' : '#ffffff',
      'bg-module-platform': dark ? '#36363c' : '#eceef1',
      'bg-mask-1': '#0008',
      'border-l1': dark ? '#45454d' : '#d6d7da',
      'border-l2': dark ? '#45454d' : '#d6d7da',
      'border-l3': dark ? '#62626a' : '#b0b1b5',
      'border-l4': dark ? '#55555d' : '#bfc0c5',
      'button-primary-fill': dark ? '#eeeeef' : '#202124',
      'button-primary-hover': dark ? '#ccccce' : '#45464a',
      'brand-primary': dark ? '#91b5ff' : '#295ab6',
      'state-business-primary': dark ? '#91b5ff' : '#295ab6',
      'interactive-bg-hover': dark ? '#ffffff18' : '#20212412',
      'interactive-bg-hover-solid': dark ? '#36363c' : '#eceef1',
      'interactive-bg-active': dark ? '#ffffff28' : '#20212422',
      'interactive-bg-hover-danger': dark ? '#ff707028' : '#b5262618',
      'state-success-primary': dark ? '#70cca0' : '#16794f',
      'state-success-tertiary': dark ? '#203c30' : '#e1f2e9',
      'state-error-primary': dark ? '#ff9292' : '#b52626',
      'state-warn-primary': dark ? '#ebc16c' : '#805500',
      'markdown-code-block': dark ? '#222226' : '#f6f7f8',
    }
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--dsw-alias-${name}`, value)
    document.documentElement.style.colorScheme = theme
    document.documentElement.style.color = tokens['label-primary']
    document.documentElement.style.backgroundColor = tokens['bg-base']
  }, theme)
}

export async function controlAppearance(control) {
  return control.evaluate(element => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = color => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]))
    const luminance = color => color.slice(0, 3).map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const contrast = (a, b) => {
      const values = [luminance(a), luminance(b)].sort((a, b) => a - b)
      return (values[1] + 0.05) / (values[0] + 0.05)
    }
    const background = node => {
      const ancestors = []
      for (; node; node = node.parentElement) ancestors.unshift(node)
      let color = [255, 255, 255]
      for (const ancestor of ancestors) color = blend(rgba(getComputedStyle(ancestor).backgroundColor), color)
      return color
    }
    const style = getComputedStyle(element)
    const visibleOpacity = node => {
      let opacity = 1
      for (; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity)
      return opacity
    }
    const textContrast = node => {
      const bg = background(node)
      const color = rgba(getComputedStyle(node).color)
      color[3] *= visibleOpacity(node)
      return contrast(blend(color, bg), bg)
    }
    const rect = element.getBoundingClientRect()
    const textNodes = [element, ...element.querySelectorAll('*')].filter(node =>
      [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
      && node.getClientRects().length > 0)
    const formValue = element.matches('input,textarea') && element.value
      ? [element] : element.matches('select') && element.selectedOptions.length
        ? [element] : []
    const foregrounds = textNodes.length ? textNodes : formValue.length ? formValue : element.querySelector('svg') ? [element] : []
    const shadowVisible = [...style.boxShadow.matchAll(/(rgba?\([^)]*\))([^,]*)/g)].some(([, color, geometry]) => {
      const values = geometry.match(/-?[\d.]+px/g)?.map(parseFloat) ?? []
      const foreground = rgba(color)
      foreground[3] *= visibleOpacity(element)
      const bg = background(element.parentElement)
      return !geometry.includes('inset') && values.length === 4
        && values.slice(0, 3).every(value => value === 0) && values[3] >= 1
        && contrast(blend(foreground, bg), bg) >= 3
    })
    const outlineContrast = node => {
      const color = rgba(getComputedStyle(node).outlineColor)
      color[3] *= visibleOpacity(node)
      const bg = background(node.parentElement)
      return contrast(blend(color, bg), bg)
    }
    const minContrast = Math.min(...foregrounds.map(textContrast))
    const busyOwner = element.closest('.ptcPlusBindings[aria-busy=true]')
    const busyStatus = busyOwner?.querySelector('.ptcPlusWorkbenchFeedback[role=status]')
    return {
      width: rect.width, height: rect.height, left: rect.left, right: rect.right,
      top: rect.top, bottom: rect.bottom,
      reachable: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
      padding: parseFloat(style.paddingLeft), minContrast,
      color: style.color, background: style.backgroundColor, effectiveBackground: background(element), border: style.borderColor,
      textColors: foregrounds.map(node => getComputedStyle(node).color),
      primary: element.getAttribute('data-kind') === 'primary' || /primary/.test(element.className),
      busyFeedback: Boolean(busyStatus?.textContent.trim() && busyStatus.getClientRects().length
        && textContrast(busyStatus) >= 3),
      borderWidth: parseFloat(style.borderTopWidth),
      borderContrast: contrast(blend(rgba(style.borderTopColor), background(element.parentElement)), background(element.parentElement)),
      fillAlpha: rgba(style.backgroundColor)[3],
      parentFocus: element.parentElement ? {
        outline: getComputedStyle(element.parentElement).outlineStyle,
        width: parseFloat(getComputedStyle(element.parentElement).outlineWidth),
        contrast: outlineContrast(element.parentElement),
      } : null,
      shadow: style.boxShadow, shadowVisible, outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor,
      outlineContrast: outlineContrast(element),
      opacity: parseFloat(style.opacity), cursor: style.cursor,
      disabled: element.disabled === true, focusVisible: element.matches(':focus-visible'),
    }
  })
}

const feedback = value => ({
  background: value.effectiveBackground,
  color: value.color,
  textColors: value.textColors,
  border: value.borderWidth > 0 && value.borderContrast >= 3 ? value.border : null,
  shadow: value.shadowVisible ? value.shadow : null,
})

export async function assertControlVisual(control, options = {}) {
  const { action = false, hover = false, focus = true, disabled = false, label = 'control' } = options
  const page = control.page()
  await control.scrollIntoViewIfNeeded()
  await control.evaluate(element => element.blur())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(180)
  const normal = await controlAppearance(control)
  assert.ok(normal.height >= (action ? 28 : 16) && normal.width >= 12, `${label}: control dimensions lost`)
  assert.ok(normal.left >= -1 && normal.right <= page.viewportSize().width + 1 && normal.reachable,
    `${label}: control is clipped or covered`)
  if (action) assert.ok(normal.padding >= 10, `${label}: action padding lost`)
  if (normal.primary) assert.ok(normal.fillAlpha > 0, `${label}: primary fill lost`)
  if (!normal.disabled) assert.ok(normal.minContrast >= 3, `${label}: unreadable control (${normal.minContrast.toFixed(2)}:1)`)
  const selectedBinding = await control.evaluate(element => element.matches('.ptcPlusBindingSelect')
    && element.closest('.ptcPlusBindingItem')?.getAttribute('data-selected') === 'true')
  if (hover && !normal.disabled) {
    await control.hover()
    await page.waitForTimeout(180)
    const hovered = await controlAppearance(control)
    assert.ok(hovered.minContrast >= 3, `${label}: unreadable hover`)
    assert.equal(hovered.width, normal.width, `${label}: hover changes width`)
    assert.equal(hovered.height, normal.height, `${label}: hover changes height`)
    if (!selectedBinding) assert.notDeepEqual(feedback(hovered), feedback(normal), `${label}: hover feedback lost`)
  }
  if (focus && !normal.disabled) {
    await page.mouse.move(0, 0)
    await page.keyboard.press('Tab')
    await control.focus()
    await page.waitForTimeout(180)
    const focused = await controlAppearance(control)
    assert.ok(focused.minContrast >= 3, `${label}: unreadable focused control (${focused.minContrast.toFixed(2)}:1)`)
    assert.equal(focused.focusVisible, true, `${label}: keyboard focus not established`)
    assert.ok((focused.outline !== 'none' && focused.outlineWidth >= 1 && focused.outlineContrast >= 3)
      || (focused.parentFocus?.outline !== 'none' && focused.parentFocus?.width >= 1
        && focused.parentFocus?.contrast >= 3 && normal.parentFocus?.outline === 'none')
      || (focused.border !== normal.border && focused.borderWidth > 0 && focused.borderContrast >= 3)
      || (focused.shadowVisible && focused.shadow !== normal.shadow),
    `${label}: visible keyboard focus lost (${JSON.stringify({ normal, focused })})`)
    assert.ok(focused.reachable, `${label}: focused control is covered`)
    await control.evaluate(element => element.blur())
  }
  if (disabled || normal.disabled) {
    const previous = await control.evaluate(element => {
      const value = element.disabled
      element.disabled = true
      return value
    })
    try {
      const inactive = await controlAppearance(control)
      assert.ok(inactive.opacity < normal.opacity || (normal.disabled && inactive.opacity <= 0.6)
        || inactive.color !== normal.color || (inactive.busyFeedback && inactive.cursor === 'wait'),
      `${label}: disabled feedback lost`)
      assert.ok(inactive.cursor === 'not-allowed' || inactive.cursor === 'default'
        || (inactive.busyFeedback && inactive.cursor === 'wait'), `${label}: disabled cursor lost`)
      await control.focus()
      assert.equal(await control.evaluate(element => element === document.activeElement), false,
        `${label}: disabled control accepts focus`)
    } finally {
      await control.evaluate((element, value) => { element.disabled = value }, previous)
    }
  }
  return normal
}

// Sample each responsibility rather than every repeated binding row.
export const surfaceControls = [
  ['action', '.ptcPlusButton,button[class*="primary"],button[class*="outline"],button[class*="ghost"]', { action: true, hover: true, disabled: true }],
  ['settings disclosure', '.ptcPlusHeader', { hover: true }],
  ['binding selection', '.ptcPlusBindingSelect', { hover: true }],
  ['binding switch', '.ptcPlusBindingSwitch', { disabled: true }],
  ['icon command', '.ptcPlusIconButton', { hover: true, disabled: true }],
  ['input', '.ptcPlusInput:not([type=checkbox])', { disabled: true }],
  ['instructions', 'textarea.ptcPlusInput,.ptcPlusTextarea', { disabled: true }],
  ['settings switch', '.ptcPlusCheck', { disabled: true }],
  ['select', '.ptcPlusSelect', {}],
  ['search', '.ptcPlusSearch input', {}],
  ['REPL observation', '.ptcPlusObservationSelect', {}],
  ['REPL definition', '.ptcPlusReplBindingTrigger', { hover: true }],
  ['REPL tab', '.ptcPlusReplTab', {}],
  ['source disclosure', '.ptcPlusBindingSourceDetails>summary,.ptcPlusEntrySettings>summary', {}],
  ['dock disclosure', '.ptcPlusBindingDockToggle', { hover: true }],
  ['tool disclosure', '.ptcPlusToolSummary[data-expandable=true]', {}],
]

export async function assertVisualSurface(page, root = page.locator('body'), label = 'surface') {
  const checked = []
  for (const [name, selector, options] of surfaceControls) {
    const controls = await root.locator(selector).all()
    const visible = (await Promise.all(controls.map(async control => ({ control, visible: await control.isVisible() }))))
      .filter(item => item.visible).map(item => item.control)
    if (!visible.length) continue
    await assertControlVisual(visible[0], { ...options, label: `${label}/${name}` })
    if (name === 'binding selection') {
      const unselected = await root.locator('.ptcPlusBindingItem:not([data-selected=true]) .ptcPlusBindingSelect').all()
      const control = (await Promise.all(unselected.map(async control => ({ control, visible: await control.isVisible() }))))
        .find(item => item.visible)?.control
      if (control) await assertControlVisual(control, { ...options, label: `${label}/${name}/unselected` })
    }
    checked.push(name)
  }
  return checked
}

export async function assertToolStateVisual(root, label = 'tool state') {
  for (const text of await root.locator('.ptcPlusToolState,.ptcPlusToolDescription').all()) {
    if (!await text.isVisible() || !await text.innerText()) continue
    const appearance = await controlAppearance(text)
    assert.ok(appearance.minContrast >= 3, `${label}: unreadable tool state (${appearance.minContrast.toFixed(2)}:1)`)
  }
}

export async function assertContentCounterexamples(page, { input, selected }) {
  if (input) assert.ok(await input.inputValue(), 'input contrast probe needs actual renderer value')
  if (selected) assert.equal(await selected.isDisabled(), false, 'selected hover probe needs enabled renderer control')
  for (const [control, rule, options, error] of [
    [input, '[data-visual-probe]{color:white!important;background:white!important}', { focus: false }, /unreadable control/],
    [selected, '[data-visual-probe]:hover,[data-visual-probe]:hover *{color:white!important;background:white!important}', { hover: true, focus: false }, /unreadable hover/],
  ]) {
    if (!control) continue
    await assertControlVisual(control, { ...options, label: 'content legal control' })
    await control.evaluate(element => element.setAttribute('data-visual-probe', 'true'))
    const sheet = await page.addStyleTag({ content: rule })
    try {
      await assert.rejects(() => assertControlVisual(control, options), error)
    } finally {
      await sheet.evaluate(element => element.remove())
      await control.evaluate(element => element.removeAttribute('data-visual-probe'))
    }
  }
}

export async function assertVisualCounterexamples(page, control) {
  // Faults retain component classes, handlers and DOM. Each must reach its own oracle failure.
  await page.mouse.move(0, 0)
  await control.evaluate(element => element.blur())
  await page.waitForTimeout(180)
  const normal = await controlAppearance(control)
  for (const [name, css, options, error] of [
    ['padding', 'padding:0!important', { action: true }, /action padding lost/],
    ['fill', 'background:transparent!important', {}, /primary fill lost/],
    ['foreground', 'color:rgb(1,1,1)!important;background:rgb(1,1,1)!important', {}, /unreadable control/],
    ['opacity', 'opacity:0!important', {}, /unreadable control/],
    ['hover', `background:${normal.background}!important;color:${normal.color}!important;border-color:${normal.border}!important;box-shadow:none!important`, { hover: true }, /hover feedback lost/],
    ['focus', 'outline:none!important;border-color:transparent!important;box-shadow:none!important', {}, /visible keyboard focus lost/],
    ['focused foreground', 'color:white!important;background:white!important;outline:2px solid black!important;box-shadow:none!important', {}, /unreadable focused control/],
    ['transparent outline', 'outline:2px solid transparent!important;border-color:transparent!important;box-shadow:none!important', {}, /visible keyboard focus lost/],
    ['disabled', 'opacity:1!important;cursor:pointer!important', { disabled: true, focus: false }, /disabled feedback lost/],
  ]) {
    await control.evaluate(element => element.setAttribute('data-visual-probe', 'true'))
    const content = name === 'focused foreground'
      ? `[data-visual-probe]:focus-visible{${css}}`
      : `[data-visual-probe]{${css}}`
    const sheet = await page.addStyleTag({ content })
    try {
      await assert.rejects(() => assertControlVisual(control, { ...options, label: name }), error)
    } finally {
      await sheet.evaluate(element => element.remove())
      await control.evaluate(element => element.removeAttribute('data-visual-probe'))
    }
  }
  // A painted ring is a valid alternative; transparent shadows cannot prove focus.
  await control.evaluate(element => element.setAttribute('data-visual-probe', 'true'))
  for (const [shadow, accepted] of [[`0 0 0 3px transparent`, false],
    [`0 0 0 -3px ${normal.background}`, false], [`inset 0 0 0 3px ${normal.background}`, false],
    [`0 0 0 3px ${normal.background}`, true]]) {
    const sheet = await page.addStyleTag({ content: `[data-visual-probe]{outline:none!important;border-color:transparent!important;box-shadow:none!important}[data-visual-probe]:focus-visible{box-shadow:${shadow}!important}` })
    try {
      if (accepted) await assertControlVisual(control, { label: 'painted focus ring' })
      else await assert.rejects(() => assertControlVisual(control), /visible keyboard focus lost/)
    } finally {
      await sheet.evaluate(element => element.remove())
    }
  }
  await control.evaluate(element => element.removeAttribute('data-visual-probe'))
}
