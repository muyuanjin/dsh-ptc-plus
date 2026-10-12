import { derivePtcToolView } from './client-activity.js'
import { isHostComponent } from './client-host-compat.js'
import { createToolHover, toolHoverExcerpt } from './client-tool-hover.js'

/**
 * run_code / edit_run_code tool rows. The row is a pure projection of the
 * recorded tool block: source, result, features and inspection, with the newer
 * DisclosureRow when the host provides it and an accessible fallback otherwise.
 */
export function createPtcToolView(React, deps) {
  const { CodeBlock, DisclosureRow, createPortal, icons } = deps
  const h = React.createElement
  const hasDisclosureRow = isHostComponent(DisclosureRow)
  const { ToolHoverAnchor } = createToolHover(React, createPortal)

  function PTCPlusToolRow({ toolName, block, inspect, t, hoverEnabled = true }) {
    const [open, setOpen] = React.useState(false)
    const view = derivePtcToolView(block, toolName)
    const previewable = view.code !== '' || view.output !== ''
    const expandable = previewable || typeof inspect === 'function'
    const stateKey = {
      running: 'tool.running',
      ok: 'tool.completed',
      error: 'tool.failed',
      stopped: 'tool.stopped',
    }[view.state]
    const outputSummary = view.state === 'error' && view.output !== ''
      ? view.output.split(/\r?\n/, 1)[0]
      : ''
    const summary = outputSummary || view.description
    const stateText = view.state === 'ok' ? null : t(stateKey)
    const toggle = () => {
      if (expandable) setOpen(current => !current)
    }
    const summaryText = summary === '' ? null : summary
    // An auto-filled summary stays visually identical but declares its provenance in the DOM
    // and on hover, so readers can tell who wrote it without changing the model-facing result.
    const generatedSummary = view.descriptionGenerated && outputSummary === ''
    const summaryLine = stateText === null && summaryText === null ? null
      : h('div', { className: 'ptcPlusToolSummaryLine', 'data-state': view.state, role: 'status' },
        stateText === null ? null : h('span', { className: 'ptcPlusToolState' }, stateText),
        summaryText === null ? null : h('span', { className: 'ptcPlusToolSep', 'aria-hidden': true }),
        summaryText === null ? null : h('span', { className: 'ptcPlusToolDescription',
          'data-generated': generatedSummary ? 'true' : undefined,
          title: generatedSummary ? t('tool.descriptionGenerated') : undefined }, summaryText))
    const renderBody = (withInspect) => h('div', { className: 'ptcPlusToolBody' },
      view.code === '' ? null : h('div', { className: 'ptcPlusToolSection' },
        h('span', { className: 'ptcPlusToolSectionLabel' }, t('tool.source')),
        isHostComponent(CodeBlock)
          ? h(CodeBlock, {
            code: view.code, lang: 'typescript', className: 'ptcPlusToolCode',
            copyLabel: t('tool.copy'), copiedLabel: t('tool.copied'),
          })
          : h('pre', { className: 'ptcPlusToolCode' }, view.code)),
      view.output === '' ? null : h('div', { className: 'ptcPlusToolSection' },
        h('span', { className: 'ptcPlusToolSectionLabel' }, t('tool.result')),
        h('div', { className: 'ptcPlusIoCard' },
          h('pre', {
            className: 'ptcPlusIoText',
            'data-error': view.state === 'error' || undefined,
          }, view.output))),
      !withInspect || typeof inspect !== 'function' ? null : h('button', {
        type: 'button', className: 'ptcPlusInspect', onClick: inspect,
      }, h(icons.inspect, { 'aria-hidden': true }), t('tool.inspect')))
    const features = view.features.length === 0 ? null : h('div', { className: 'ptcPlusFeatures' },
      view.features.map(feature => h('span', {
        key: `${feature.key}:${feature.detail}`, className: 'ptcPlusFeature',
      },
      h('span', { className: 'ptcPlusFeatureName' }, t(feature.key)),
      feature.detail === '' ? null
        : h('span', { className: 'ptcPlusFeatureDetail', title: feature.detail }, feature.detail))))
    const collapsedContent = h('div', { className: 'ptcPlusToolPreview' }, summaryLine, features)
    const body = open ? renderBody(true) : null
    const sourceExcerpt = toolHoverExcerpt(view.code, 6)
    const outputExcerpt = toolHoverExcerpt(view.output, 3)
    const preview = h(React.Fragment, null,
      h('div', { className: 'ptcPlusToolHoverHeader', 'data-state': view.state },
        h('span', { className: 'ptcPlusToolHoverHeading' },
          t(toolName === 'edit_run_code' ? 'tool.editPreview' : 'tool.preview')),
        h('span', { className: 'ptcPlusToolHoverState' }, t(stateKey))),
      h('div', { className: 'ptcPlusToolHoverContent' },
        view.description === '' ? null : h('div', { className: 'ptcPlusToolHoverDescription',
          'data-generated': view.descriptionGenerated ? 'true' : undefined,
          title: view.descriptionGenerated ? t('tool.descriptionGenerated') : undefined }, view.description),
        view.code === '' ? null : h('div', { className: 'ptcPlusToolHoverSection' },
          h('span', { className: 'ptcPlusToolSectionLabel' }, `${t('tool.source')} · TypeScript`),
          isHostComponent(CodeBlock) ? h(CodeBlock, {
            code: sourceExcerpt.text, lang: 'typescript', showHeader: false, lineNumbers: true,
            className: 'ptcPlusToolCode ptcPlusToolHoverCode',
          }) : h('pre', { className: 'ptcPlusToolCode ptcPlusToolHoverCode' }, sourceExcerpt.text)),
        view.output === '' ? null : h('div', { className: 'ptcPlusToolHoverSection' },
          h('span', { className: 'ptcPlusToolSectionLabel' }, t('tool.result')),
          h('pre', { className: 'ptcPlusIoText', 'data-error': view.state === 'error' || undefined }, outputExcerpt.text)),
        features),
      h('div', { className: 'ptcPlusToolHoverFooter' },
        h('span', null, t('tool.previewHint')),
        h('span', { className: 'ptcPlusToolHoverBounded',
          'data-truncated': sourceExcerpt.truncated || outputExcerpt.truncated || undefined,
        }, t('tool.previewBounded'))))
    const wrapRow = anchor => h(ToolHoverAnchor, { disabled: !hoverEnabled || open || !previewable, content: preview }, anchor)
    if (hasDisclosureRow) {
      return wrapRow(
        h(DisclosureRow, {
          icon: expandable
            ? h(icons.chevron, { size: 14 })
            : h(icons.check, { size: 14 }),
          title: t(toolName === 'edit_run_code' ? 'tool.codeEdit' : 'tool.code'),
          open,
          expandable,
          onToggle: toggle,
          expandOnRowClick: true,
          previewChevron: false,
          keepContentWhenOpen: true,
          className: 'ptcPlusToolDisclosure',
          rowClassName: 'ptcPlusToolRow',
          contentClassName: 'ptcPlusToolDisclosureContent',
          contentLayoutClassName: 'ptcPlusToolDisclosureLayout',
          titleClassName: 'ptcPlusToolTitle',
          collapsedContent,
          children: body,
        }))
    }
    return wrapRow(h(React.Fragment, null,
      h('div', {
        className: 'ptcPlusToolSummary', 'data-state': view.state,
        'data-expandable': expandable || undefined,
        role: expandable ? 'button' : undefined,
        tabIndex: expandable ? 0 : undefined,
        'aria-expanded': expandable ? open : undefined,
        onClick: expandable ? toggle : undefined,
        onKeyDown: expandable ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        } : undefined,
      },
      h('span', { className: 'ptcPlusToolLeading', 'aria-hidden': true }, expandable
        ? h(icons.chevron, { size: 14, className: 'ptcPlusToolChevron', 'data-open': open })
        : h(icons.check, { size: 14 })),
      h('span', { className: 'ptcPlusToolTitle' }, t(
        toolName === 'edit_run_code' ? 'tool.codeEdit' : 'tool.code')),
      view.state === 'ok' ? null
        : h('span', { className: 'ptcPlusToolState', role: 'status' }, t(stateKey)),
      h('span', { className: 'ptcPlusToolSep', 'aria-hidden': true }),
      h('span', { className: 'ptcPlusToolDescription' }, summary)),
      features,
      body))
  }

  return { PTCPlusToolRow }
}
