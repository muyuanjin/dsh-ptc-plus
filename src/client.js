import { CONFIG_FIELDS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { derivePtcToolView } from './client-activity.js'
import {
  normalizeReplMemorySnapshot,
  unavailableReplMemorySnapshot,
} from '../internal/repl-memory-projection.js'

const CLIENT_STYLE_ID = 'ptc-plus-client-style'
const CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}
.ptcPlusActiveShell{display:inline-flex;align-items:center}.ptcPlusActive{appearance:none;display:inline-flex;height:24px;align-items:center;gap:5px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 32%,transparent);border-radius:6px;background:var(--dsw-alias-state-success-tertiary,#e7f7ef);color:var(--dsw-alias-state-success-primary,#16794f);cursor:help;font:600 12px/18px inherit;white-space:nowrap;transition:background-color .14s ease,border-color .14s ease}.ptcPlusActive:hover,.ptcPlusActive[aria-expanded=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 16%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusActive:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary,#16794f);outline-offset:2px}.ptcPlusReplPopover{position:fixed;z-index:2147483000;inset:auto;display:none;box-sizing:border-box;margin:0;padding:0;border:0;overflow:visible;background:transparent;color:var(--dsw-alias-label-primary,#18191c)}.ptcPlusReplPopover:popover-open,.ptcPlusReplPopover[data-open=true]{display:block}.ptcPlusReplPopover::backdrop{background:transparent}.ptcPlusReplCard{display:flex;max-height:inherit;overflow:hidden;flex-direction:column;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 22%,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));border-top:3px solid var(--dsw-alias-state-success-primary,#16794f);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 14px 36px rgba(16,24,40,.2),0 3px 10px rgba(16,24,40,.1);color:var(--dsw-alias-label-primary,#18191c);white-space:normal}.ptcPlusReplHead{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:8px;padding:11px 13px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 7%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusReplStatusDot{grid-row:1/3;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16794f);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 14%,transparent)}.ptcPlusReplTitle,.ptcPlusReplSummary{display:block;min-width:0}.ptcPlusReplTitle{font-size:13px;font-weight:600;line-height:19px}.ptcPlusReplSummary{color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:16px}.ptcPlusReplList{min-height:0;margin:0;padding:5px 0;overflow:auto;overscroll-behavior:contain;list-style:none;scrollbar-gutter:stable}.ptcPlusReplBinding{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 10px;padding:7px 12px}.ptcPlusReplBinding:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusReplIdentity{display:flex;min-width:0;align-items:center;gap:7px}.ptcPlusReplName{min-width:0;overflow:hidden;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplKind{flex:none;padding:1px 6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:10px;font-weight:600;line-height:15px}.ptcPlusReplKind[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplKind[data-kind=function]{color:#7651b5}.ptcPlusReplKind[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplKind[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplInspect{grid-column:2;grid-row:1/3;display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;font:500 11px/17px inherit;white-space:nowrap}.ptcPlusReplInspect:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusReplInspect:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:1px}.ptcPlusReplDefinition{grid-column:1/-1;min-width:0;margin-top:4px;padding:8px;border-left:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusReplLocation{display:block;margin-bottom:5px;color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;line-height:15px}.ptcPlusReplCode{max-height:180px;margin:0;overflow:auto;color:inherit;font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusReplEmpty,.ptcPlusReplMore{display:block;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusReplEmpty{padding:18px 13px;font-size:12px;line-height:18px}.ptcPlusReplMore{padding:8px 13px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03));font-size:11px;line-height:17px}
.ptcPlusReplList{max-height:min(52vh,480px)}.ptcPlusReplBinding{grid-template-columns:minmax(0,1fr) 24px;gap:3px 8px;min-height:36px;padding:5px 12px;content-visibility:auto;contain-intrinsic-size:36px;cursor:pointer;transition:background-color .16s ease}.ptcPlusReplBinding:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}.ptcPlusReplBinding[data-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 5%,transparent)}.ptcPlusReplName{grid-column:1}.ptcPlusReplName[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplName[data-kind=function]{color:#7651b5}.ptcPlusReplName[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplName[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1}.ptcPlusReplChevron{grid-column:2;grid-row:1/3;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .2s ease}.ptcPlusReplChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusReplDefinitionWrap{grid-column:1/-1;display:grid;grid-template-rows:0fr;min-width:0;transition:grid-template-rows .24s cubic-bezier(.2,.7,.2,1)}.ptcPlusReplDefinitionWrap[data-open=true]{grid-template-rows:1fr}.ptcPlusReplDefinitionInner{min-height:0;overflow:hidden}
.ptcPlusTool{display:flex;min-width:0;flex-direction:column}.ptcPlusToolPreview{display:flex;min-width:0;flex:1 1 auto;flex-direction:row;align-items:center;overflow:hidden;margin-left:7px}.ptcPlusToolPreview .ptcPlusFeatures{flex:0 1 auto;flex-wrap:nowrap;overflow:hidden;margin:0 0 0 7px}.ptcPlusToolSummaryLine{box-sizing:border-box;display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary{box-sizing:border-box;display:flex;min-width:0;min-height:32px;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary[data-expandable=true]{cursor:pointer}.ptcPlusToolSummary[data-expandable=true]:hover .ptcPlusToolTitle{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:2px}.ptcPlusToolLeading{display:flex;width:16px;height:20px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolChevron{transition:transform .16s ease}.ptcPlusToolChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusToolTitle{display:flex;height:20px;flex:none;align-items:center;font-size:13px;font-weight:500;line-height:20px}.ptcPlusToolState{display:flex;height:20px;flex:none;align-items:center;color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:20px}.ptcPlusToolSummaryLine[data-state=running] .ptcPlusToolState,.ptcPlusToolSummary[data-state=running] .ptcPlusToolState{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolState,.ptcPlusToolSummary[data-state=error] .ptcPlusToolState{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolState,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolState{color:var(--dsw-alias-state-warning-primary,#a15c00)}.ptcPlusToolSep{width:3px;height:3px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolDescription{display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;overflow:hidden;color:var(--dsw-alias-label-secondary,#52565d);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeature{flex:none;max-width:180px;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeatureDetail{max-width:120px}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=error] .ptcPlusToolDescription{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolDescription{color:var(--dsw-alias-state-warning-primary,#a15c00)}
.ptcPlusFeatures{display:flex;min-width:0;flex-wrap:wrap;gap:3px 14px;margin:0 0 5px 23px}.ptcPlusFeature{display:inline-flex;min-width:0;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;line-height:17px}.ptcPlusFeature::before{width:4px;height:4px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-primary,#4d6bfe);content:''}.ptcPlusFeatureName{font-weight:500}.ptcPlusFeatureDetail{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.ptcPlusToolBody{margin:4px 0 8px 23px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusToolSection{display:flex;min-width:0;flex-direction:column;gap:4px;padding:9px 11px}.ptcPlusToolSection+.ptcPlusToolSection{border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusToolSectionLabel{color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;font-weight:600;line-height:16px;text-transform:uppercase}.ptcPlusToolCode{max-height:320px;margin:0;overflow:auto;color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoCard{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-markdown-code-block,rgba(38,49,72,.06));overflow:hidden}.ptcPlusIoText{max-height:320px;margin:0;padding:12px 16px;overflow:auto;color:var(--dsw-alias-label-secondary,#52565d);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoText[data-error]{color:var(--dsw-alias-state-error-primary,#c43d3d)}.ptcPlusInspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;opacity:0;font-size:11px;line-height:16px;transition:opacity .1s ease;display:inline-flex}.ptcPlusTool:hover .ptcPlusInspect,.ptcPlusInspect:focus-visible{opacity:1}.ptcPlusInspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#18191c)}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}.ptcPlusFeatures,.ptcPlusToolBody{margin-left:0}.ptcPlusToolSummary .ptcPlusToolDescription{white-space:normal;overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton,.ptcPlusActive,.ptcPlusToolChevron,.ptcPlusReplChevron,.ptcPlusReplDefinitionWrap,.ptcPlusInspect{transition:none}}
/* The summary button owns disclosure; definition content is a separate grid item. */
.ptcPlusReplBinding{padding:0;cursor:default}.ptcPlusReplBindingTrigger{appearance:none;display:grid;width:100%;grid-column:1/-1;grid-template-columns:minmax(0,1fr) 24px;gap:3px 8px;min-height:36px;padding:5px 12px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background-color .16s ease}.ptcPlusReplBindingTrigger:hover,.ptcPlusReplBindingTrigger[aria-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 5%,transparent)}.ptcPlusReplBindingTrigger:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
/* High-contrast TypeScript-like token colors adapt to the active text theme. */
.ptcPlusReplCard .ptcPlusReplName[data-kind=variable]{color:color-mix(in srgb,#005cc5 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=function]{color:color-mix(in srgb,#795e26 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=class]{color:color-mix(in srgb,#267f99 78%,var(--dsw-alias-label-primary,#18191c))}
.ptcPlusReplCard .ptcPlusReplName[data-kind=import]{color:color-mix(in srgb,#af00db 78%,var(--dsw-alias-label-primary,#18191c))}
/* Keep the session-header action on the same compact 32px rhythm as DSH chrome. */
.ptcPlusActiveShell{display:inline-flex;height:28px;align-items:center;justify-content:center;line-height:0;vertical-align:middle}.ptcPlusActive{box-sizing:border-box;height:28px;justify-content:center;gap:6px;padding:0 6px;border:0;background:transparent;font-family:inherit;font-size:13px;font-weight:500;line-height:18px}.ptcPlusActive::before{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px color-mix(in srgb,currentColor 18%,transparent);content:''}.ptcPlusActive:hover,.ptcPlusActive[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusActiveLabel{display:inline-flex;height:18px;align-items:center;line-height:18px}
`

/** Locale namespace owning every settings-card string (field copy plus chrome). */
const LOCALE_NS = 'settings.ptcPlus'

/** Card chrome copy; field labels and hints ride the shared config spec. */
const CHROME_COPY = Object.freeze({
  zh: Object.freeze({
    'card.description': 'PTC 模式的会话级 TypeScript REPL。',
    'status.enabled': '已启用',
    'status.disabled': '已停用',
    'action.expand': '展开 PTC Plus 设置',
    'action.collapse': '收起 PTC Plus 设置',
    'state.syncing': '正在同步设置...',
    'state.unavailable': '当前 DSH 实例未提供设置服务',
    'footer.live': '设置会在修改后立即生效',
    'footer.readOnly': '当前设置为只读',
    'status.applied': '设置已立即生效',
    'status.conflict': '设置未生效，请检查设置冲突',
    'status.failed': '设置失败：{error}',
    'indicator.title': 'PTC Plus 已启用；查看当前可复用的 REPL 绑定',
    'memory.title': 'REPL 可复用绑定',
    'memory.count': '{count} 个可复用绑定',
    'memory.empty': '当前没有可复用绑定',
    'memory.unavailable': '当前绑定状态尚不可确认',
    'memory.more': '另有 {count} 个绑定未显示',
    'memory.kind.variable': '变量',
    'memory.kind.function': '函数',
    'memory.kind.class': '类',
    'memory.kind.import': '导入',
    'memory.location': '第 {line} 行，第 {column} 列',
    'tool.code': '执行',
    'tool.codeEdit': '修正执行',
    'tool.running': '正在运行',
    'tool.completed': '执行完成',
    'tool.failed': '执行失败',
    'tool.stopped': '执行已中断',
    'tool.source': '源码',
    'tool.result': '结果',
    'tool.copy': '复制代码',
    'tool.copied': '已复制',
    'tool.inspect': '检查调用',
    'feature.safeEdit': '安全编辑执行',
    'feature.codeRun': '隔离执行 code.run',
    'feature.stateSaved': '保存 REPL 状态',
    'feature.stateRestored': '恢复 REPL 状态',
    'feature.stateDeleted': '删除 REPL 状态',
  }),
  en: Object.freeze({
    'card.description': 'The session-bound TypeScript REPL for PTC mode.',
    'status.enabled': 'Enabled',
    'status.disabled': 'Disabled',
    'action.expand': 'Expand PTC Plus settings',
    'action.collapse': 'Collapse PTC Plus settings',
    'state.syncing': 'Syncing settings...',
    'state.unavailable': 'This DSH instance does not provide a settings service',
    'footer.live': 'Changes take effect immediately.',
    'footer.readOnly': 'These settings are read-only.',
    'status.applied': 'Setting applied immediately.',
    'status.conflict': 'The setting did not take effect; check for conflicting settings.',
    'status.failed': 'Could not save: {error}',
    'indicator.title': 'PTC Plus is active; view reusable REPL bindings',
    'memory.title': 'Reusable REPL bindings',
    'memory.count': '{count} reusable bindings',
    'memory.empty': 'No reusable bindings',
    'memory.unavailable': 'Current binding state cannot be confirmed',
    'memory.more': '{count} more bindings not shown',
    'memory.kind.variable': 'Variable',
    'memory.kind.function': 'Function',
    'memory.kind.class': 'Class',
    'memory.kind.import': 'Import',
    'memory.location': 'Line {line}, column {column}',
    'tool.code': 'Code',
    'tool.codeEdit': 'Code edit',
    'tool.running': 'Running',
    'tool.completed': 'Completed',
    'tool.failed': 'Failed',
    'tool.stopped': 'Stopped',
    'tool.source': 'Source',
    'tool.result': 'Result',
    'tool.inspect': 'Inspect call',
    'feature.safeEdit': 'Safe edit execution',
    'feature.codeRun': 'Isolated code.run execution',
    'feature.stateSaved': 'Saved REPL state',
    'feature.stateRestored': 'Restored REPL state',
    'feature.stateDeleted': 'Deleted REPL state',
    'tool.copy': 'Copy code',
    'tool.copied': 'Copied',
  }),
})

/** Project one field's copy into locale dictionary keys; an empty hint has no key. */
function fieldCopy(field, locale) {
  const copy = { [`${field.key}.label`]: locale === 'en' ? field.labelEn : field.label }
  const description = locale === 'en' ? field.descriptionEn : field.description
  if (description !== '') copy[`${field.key}.description`] = description
  return copy
}

/** Complete dictionaries for both shipped locales, derived once from the spec. */
const SETTINGS_COPY = Object.freeze(Object.fromEntries(
  ['zh', 'en'].map(locale => [locale, Object.freeze({
    ...CHROME_COPY[locale],
    ...Object.assign({}, ...CONFIG_FIELDS.map(field => fieldCopy(field, locale))),
  })]),
))

function sessionUsesPtcPreset(session) {
  const preset = session?.projectionValues?.agentPreset ?? session?.agentPreset
  return preset === 'ptc' || preset === 'code'
}

window.__ModuleLoader__.load({
  // Replaced by the bundle entry with the package name from package.json.
  id: __PTC_PLUS_CLIENT_MODULE_ID__,
  factory: (require) => {
    const React = require('react')
    const {
      CodeBlock,
      DisclosureRow,
      IconCheckOutline14,
      IconChevronDownOutline14,
      IconInspectOutline12,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const module = { exports: {} }
    const h = React.createElement

    function installStyles() {
      if (document.getElementById(CLIENT_STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = CLIENT_STYLE_ID
      style.textContent = CLIENT_CSS
      document.head.append(style)
      return () => style.remove()
    }

    function fieldInput(field, value, disabled, onChange, label) {
      if (field.type === 'boolean') {
        return h('input', {
          type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value === true,
          disabled, 'aria-label': label,
          onChange: event => onChange(field, event.target.checked),
        })
      }
      return h('input', {
        type: 'number', className: 'ptcPlusInput',
        value: Number.isSafeInteger(value) ? String(value) : '',
        min: field.min, max: field.max, step: 1, disabled, 'aria-label': label,
        onChange: event => {
          const input = event.target.value
          const parsed = input === '' ? '' : Number(input)
          onChange(field, Number.isSafeInteger(parsed) ? parsed : input)
        },
      })
    }

    function apply(ctx) {
      const preferenceScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      ctx.effect(() => ctx.locale.register(LOCALE_NS, SETTINGS_COPY), 'ptc-plus: settings dictionaries')
      ctx.effect(installStyles, 'ptc-plus: client styles')

      function PTCPlusSettingsCard({ t }) {
        const [open, setOpen] = React.useState(false)
        const [status, setStatus] = React.useState(null)
        const [pending, setPending] = React.useState(() => new Set())
        const writeTail = React.useRef(Promise.resolve())
        const subscribe = React.useCallback(listener => preferenceScope.subscribe(listener), [])
        const getSnapshot = React.useCallback(() => preferenceScope.getSnapshot(), [])
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        const value = snapshot.status === 'ready' ? (snapshot.value ?? {}) : {}
        const enabled = value.enabled === true
        const unavailable = snapshot.status !== 'ready' || snapshot.writable !== true
        const persist = (field, nextValue) => {
          if (unavailable || pending.has(field.key)) return
          const operation = writeTail.current.then(async () => {
            const before = preferenceScope.getSnapshot()
            if (before.status !== 'ready' || before.writable !== true) return
            if (field.key !== 'enabled' && before.value?.enabled !== true) return
            if (before.value?.[field.key] === nextValue) return
            setPending(current => new Set(current).add(field.key))
            setStatus(null)
            try {
              await preferenceScope.set(field.key, nextValue)
              const after = preferenceScope.getSnapshot()
              if (after.status !== 'ready' || after.value?.[field.key] !== nextValue) {
                setStatus({ key: 'status.conflict' })
              } else {
                setStatus({ key: 'status.applied' })
              }
            } catch (error) {
              setStatus({
                key: 'status.failed',
                params: { error: error instanceof Error ? error.message : String(error) },
              })
            } finally {
              setPending(current => {
                const next = new Set(current)
                next.delete(field.key)
                return next
              })
            }
          })
          writeTail.current = operation.catch(() => {})
        }
        const fieldDisabled = field => unavailable
          || pending.has(field.key)
          || (field.key !== 'enabled' && !enabled)
        return h('li', { className: 'ptcPlusCard' },
          h('button', {
            type: 'button', className: 'ptcPlusHeader', 'aria-expanded': open,
            'aria-label': t(open ? 'action.collapse' : 'action.expand'),
            'aria-controls': 'ptc-plus-settings-body', onClick: () => setOpen(current => !current),
          },
          h('span', { className: 'ptcPlusHeadText' },
            h('span', { className: 'ptcPlusName' }, 'PTC Plus'),
            h('span', { className: 'ptcPlusDescription' }, t('card.description'))),
          h('span', { className: 'ptcPlusStatus', 'data-enabled': enabled }, t(enabled ? 'status.enabled' : 'status.disabled')),
          h('span', { className: 'ptcPlusChevron', 'data-open': open, 'aria-hidden': true }, h(IconChevronDownOutline14, { size: 14 }))),
          h('div', { id: 'ptc-plus-settings-body', className: 'ptcPlusBody', 'data-open': open, 'aria-hidden': !open },
            h('div', { className: 'ptcPlusBodyInner' }, h('div', { className: 'ptcPlusFields' },
              snapshot.status === 'loading'
                ? h('p', { className: 'ptcPlusMessage' }, t('state.syncing'))
                : snapshot.status === 'unavailable'
                  ? h('p', { className: 'ptcPlusMessage' }, t('state.unavailable'))
                  : [
                    ...CONFIG_FIELDS.map(field => h('div', { key: field.key, className: 'ptcPlusRow' },
                      h('div', { className: 'ptcPlusMain' },
                        h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
                        field.description === '' ? null : h('div', { className: 'ptcPlusDetail' }, t(`${field.key}.description`))),
                      fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`)))),
                    h('div', { key: 'footer', className: 'ptcPlusFooter' },
                      h('span', { className: 'ptcPlusMessage', role: 'status' }, status === null
                        ? t(snapshot.writable ? 'footer.live' : 'footer.readOnly')
                        : t(status.key, status.params))),
                  ]))),
        )
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE_NS,
      }, PTCPlusSettingsCard))

      function PTCPlusToolRow({ toolName, block, inspect, t }) {
        const [open, setOpen] = React.useState(false)
        const view = derivePtcToolView(block, toolName)
        const expandable = view.code !== '' || view.output !== '' || typeof inspect === 'function'
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
        const summaryLine = stateText === null && summaryText === null ? null
          : h('div', { className: 'ptcPlusToolSummaryLine', 'data-state': view.state, role: 'status' },
            stateText === null ? null : h('span', { className: 'ptcPlusToolState' }, stateText),
            summaryText === null ? null : h('span', { className: 'ptcPlusToolSep', 'aria-hidden': true }),
            summaryText === null ? null : h('span', { className: 'ptcPlusToolDescription' }, summaryText))
        const body = !open ? null : h('div', { className: 'ptcPlusToolBody' },
          view.code === '' ? null : h('div', { className: 'ptcPlusToolSection' },
            h('span', { className: 'ptcPlusToolSectionLabel' }, t('tool.source')),
            typeof CodeBlock === 'function'
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
          typeof inspect !== 'function' ? null : h('button', {
            type: 'button', className: 'ptcPlusInspect', onClick: inspect,
          }, h(IconInspectOutline12, { 'aria-hidden': true }), t('tool.inspect')))
        const features = view.features.length === 0 ? null : h('div', { className: 'ptcPlusFeatures' },
          view.features.map(feature => h('span', {
            key: `${feature.key}:${feature.detail}`, className: 'ptcPlusFeature',
          },
          h('span', { className: 'ptcPlusFeatureName' }, t(feature.key)),
          feature.detail === '' ? null
            : h('span', { className: 'ptcPlusFeatureDetail', title: feature.detail }, feature.detail))))
        const collapsedContent = h('div', { className: 'ptcPlusToolPreview' }, summaryLine, features)
        if (typeof DisclosureRow === 'function') {
          return h('div', { className: 'ptcPlusTool' },
            h(DisclosureRow, {
              icon: expandable
                ? h(IconChevronDownOutline14, { size: 14 })
                : h(IconCheckOutline14, { size: 14 }),
              title: t(toolName === 'edit_run_code' ? 'tool.codeEdit' : 'tool.code'),
              open,
              expandable,
              onToggle: toggle,
              expandOnRowClick: true,
              previewChevron: false,
              keepContentWhenOpen: true,
              collapsedContent,
              children: body,
            }))
        }
        return h('div', { className: 'ptcPlusTool' },
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
            ? h(IconChevronDownOutline14, { size: 14, className: 'ptcPlusToolChevron', 'data-open': open })
            : h(IconCheckOutline14, { size: 14 })),
          h('span', { className: 'ptcPlusToolTitle' }, t(
            toolName === 'edit_run_code' ? 'tool.codeEdit' : 'tool.code')),
          view.state === 'ok' ? null
            : h('span', { className: 'ptcPlusToolState', role: 'status' }, t(stateKey)),
          h('span', { className: 'ptcPlusToolSep', 'aria-hidden': true }),
          h('span', { className: 'ptcPlusToolDescription' }, summary)),
          features,
          body)
      }

      ctx.slots.inject('tool.call.toolview', () => {
        let releaseRows
        const release = () => {
          releaseRows?.()
          releaseRows = undefined
        }
        const sync = () => {
          const snapshot = preferenceScope.getSnapshot()
          const enabled = snapshot.status === 'ready'
            && snapshot.value?.enabled === true
            && snapshot.value?.enhancedToolView !== false
          if (enabled === (releaseRows !== undefined)) return
          release()
          if (!enabled) return
          const disposers = []
          try {
            disposers.push(ctx.slots.register({
              name: 'tool.call.toolview', key: 'run_code', locale: LOCALE_NS,
            }, PTCPlusToolRow))
            disposers.push(ctx.slots.register({
              name: 'tool.call.toolview', key: 'edit_run_code', locale: LOCALE_NS,
            }, PTCPlusToolRow))
          } catch (error) {
            disposers.reverse().forEach(dispose => dispose())
            throw error
          }
          releaseRows = () => disposers.reverse().forEach(dispose => dispose())
        }
        sync()
        const unsubscribe = preferenceScope.subscribe(sync)
        return () => {
          unsubscribe()
          release()
        }
      })

      ctx.inject(['slots', 'sessions'], (scope) => {
        function replPopoverIsOpen(popover) {
          if (popover?.dataset?.open === 'true') return true
          try {
            return popover?.matches?.(':popover-open') === true
          } catch {
            return false
          }
        }

        function placeReplPopover(trigger, popover) {
          if (trigger === null || popover === null) return
          const margin = 12
          const gap = 8
          const viewportWidth = document.documentElement.clientWidth || window.innerWidth
          const viewportHeight = document.documentElement.clientHeight || window.innerHeight
          const triggerRect = trigger.getBoundingClientRect()
          const width = Math.min(344, Math.max(0, viewportWidth - margin * 2))
          const left = Math.min(
            Math.max(margin, triggerRect.right - width),
            Math.max(margin, viewportWidth - width - margin),
          )
          const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin)
          const above = Math.max(0, triggerRect.top - gap - margin)
          const opensAbove = below < 260 && above > below
          const availableHeight = Math.max(80, opensAbove ? above : below)
          popover.style.width = `${width}px`
          popover.style.maxHeight = `${availableHeight}px`
          popover.style.left = `${left}px`
          popover.style.top = opensAbove
            ? `${Math.max(margin, triggerRect.top - gap - Math.min(popover.offsetHeight, availableHeight))}px`
            : `${Math.min(viewportHeight - margin, triggerRect.bottom + gap)}px`
        }

        function ReplMemoryCard({ memory, t, id, titleId, popoverRef, onEnter, onLeave }) {
          const [expandedBinding, setExpandedBinding] = React.useState(null)
          return h('div', {
            className: 'ptcPlusReplPopover', id, ref: popoverRef, popover: 'auto',
            role: 'dialog', 'aria-labelledby': titleId,
            onPointerEnter: onEnter, onPointerLeave: onLeave,
          },
          h('div', { className: 'ptcPlusReplCard' },
            h('div', { className: 'ptcPlusReplHead' },
              h('span', { className: 'ptcPlusReplStatusDot', 'aria-hidden': true }),
              h('span', { className: 'ptcPlusReplTitle', id: titleId }, t('memory.title')),
              memory.available
                ? h('span', { className: 'ptcPlusReplSummary' }, t('memory.count', { count: memory.total }))
                : null),
            !memory.available
              ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.unavailable'))
              : memory.entries.length === 0
                ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.empty'))
                : h('ul', { className: 'ptcPlusReplList' }, memory.entries.map((binding, index) => {
                  const expanded = expandedBinding === binding.name
                  const preview = binding.definition.source.replace(/\s+/g, ' ').trim()
                  const definitionId = `${id}-binding-${index}`
                  const toggle = () => setExpandedBinding(current => (
                    current === binding.name ? null : binding.name
                  ))
                  return h('li', {
                    className: 'ptcPlusReplBinding', key: binding.name,
                    'data-expanded': expanded,
                  },
                    h('button', {
                      className: 'ptcPlusReplBindingTrigger', type: 'button',
                      'aria-expanded': expanded,
                      'aria-controls': expanded ? definitionId : undefined,
                      onClick: toggle,
                    },
                      h('span', {
                        className: 'ptcPlusReplName', 'data-kind': binding.kind,
                        title: `${binding.name} - ${t(`memory.kind.${binding.kind}`)}`,
                      }, binding.name),
                      h('span', { className: 'ptcPlusReplPreview', title: preview }, preview),
                      h('span', {
                        className: 'ptcPlusReplChevron', 'data-open': expanded, 'aria-hidden': true,
                      }, h(IconChevronDownOutline14, { size: 14 }))),
                    expanded
                      ? h('div', {
                        className: 'ptcPlusReplDefinitionWrap', 'data-open': true,
                        id: definitionId, role: 'region', 'aria-label': binding.name,
                      }, h('div', { className: 'ptcPlusReplDefinitionInner' },
                        h('div', { className: 'ptcPlusReplDefinition' },
                          h('span', { className: 'ptcPlusReplLocation' }, t('memory.location', {
                            line: binding.definition.line,
                            column: binding.definition.column,
                          })),
                          typeof CodeBlock === 'function'
                            ? h(CodeBlock, {
                              code: binding.definition.source,
                              lang: 'typescript',
                              className: 'ptcPlusReplCode',
                              copyLabel: t('tool.copy'),
                              copiedLabel: t('tool.copied'),
                            })
                            : h('pre', { className: 'ptcPlusReplCode' }, binding.definition.source))))
                      : null)
                })),
            memory.omitted === 0 ? null
              : h('span', { className: 'ptcPlusReplMore' }, t('memory.more', { count: memory.omitted }))))
        }

        function PTCPlusSessionIndicator({ sessionId, t, useSession, useProjection, useSessions }) {
          // The session-scoped standard kit changed between DSH lines. Prefer its
          // public hooks when present, then fall back to the older sessions list.
          let conversation
          try {
            conversation = typeof useSession === 'function'
              ? useSession(snapshot => snapshot)
              : undefined
          } catch {
            conversation = undefined
          }
          let projectionMemory
          try {
            projectionMemory = typeof useProjection === 'function'
              ? useProjection('ptcPlusRepl')
              : undefined
          } catch {
            projectionMemory = undefined
          }
          let sessions
          try {
            sessions = typeof useSessions === 'function'
              ? useSessions(snapshot => snapshot)
              : React.useSyncExternalStore(
                listener => scope.sessions?.list?.subscribe?.(listener) ?? (() => {}),
                () => scope.sessions?.list?.getSnapshot?.() ?? {},
                () => scope.sessions?.list?.getSnapshot?.() ?? {},
              )
          } catch {
            sessions = {}
          }
          const settings = React.useSyncExternalStore(
            listener => preferenceScope.subscribe(listener),
            () => preferenceScope.getSnapshot(),
            () => preferenceScope.getSnapshot(),
          )
          const triggerRef = React.useRef(null)
          const popoverRef = React.useRef(null)
          const closeTimer = React.useRef(undefined)
          const [expanded, setExpanded] = React.useState(false)
          const positionPopover = React.useCallback(() => {
            if (!replPopoverIsOpen(popoverRef.current)) return
            placeReplPopover(triggerRef.current, popoverRef.current)
          }, [])
          const showPopover = React.useCallback(() => {
            if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
            const popover = popoverRef.current
            if (popover === null) return
            popover.style.visibility = 'hidden'
            if (!replPopoverIsOpen(popover)) {
              if (typeof popover.showPopover === 'function') {
                try {
                  popover.showPopover()
                } catch {
                  popover.dataset.open = 'true'
                }
              } else {
                popover.dataset.open = 'true'
              }
            }
            placeReplPopover(triggerRef.current, popover)
            popover.style.visibility = 'visible'
            setExpanded(true)
          }, [])
          const hidePopover = React.useCallback(() => {
            const popover = popoverRef.current
            if (popover === null) return
            if (popover.dataset.open === 'true') delete popover.dataset.open
            if (typeof popover.hidePopover === 'function' && replPopoverIsOpen(popover)) {
              try { popover.hidePopover() } catch {}
            }
            setExpanded(false)
          }, [])
          const scheduleHide = React.useCallback(() => {
            if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
            closeTimer.current = setTimeout(() => {
              closeTimer.current = undefined
              if (document.activeElement === triggerRef.current
                || popoverRef.current?.contains(document.activeElement)) return
              hidePopover()
            }, 120)
          }, [hidePopover])
          React.useEffect(() => {
            const syncPopoverState = (event) => {
              if (event.target !== popoverRef.current) return
              setExpanded(replPopoverIsOpen(popoverRef.current))
            }
            window.addEventListener('resize', positionPopover)
            document.addEventListener('scroll', positionPopover, true)
            document.addEventListener('toggle', syncPopoverState, true)
            return () => {
              if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
              window.removeEventListener('resize', positionPopover)
              document.removeEventListener('scroll', positionPopover, true)
              document.removeEventListener('toggle', syncPopoverState, true)
              const popover = popoverRef.current
              if (popover?.dataset?.open === 'true') delete popover.dataset.open
              if (typeof popover?.hidePopover === 'function' && replPopoverIsOpen(popover)) {
                try { popover.hidePopover() } catch {}
              }
            }
          }, [hidePopover, positionPopover])
          const resolvedSessionId = sessionId ?? conversation?.sessionId
          const session = sessions?.byId?.[resolvedSessionId] ?? conversation
          if (!sessionUsesPtcPreset(session)
            || settings.status !== 'ready' || settings.value?.enabled !== true) return null
          let memory
          try {
            memory = normalizeReplMemorySnapshot(projectionMemory
              ?? session?.projectionValues?.ptcPlusRepl)
          } catch {
            memory = unavailableReplMemorySnapshot()
          }
          const popoverId = `ptc-plus-repl-${String(resolvedSessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
          const titleId = `${popoverId}-title`
          return h('span', { className: 'ptcPlusActiveShell' },
            h('button', {
              type: 'button', className: 'ptcPlusActive', ref: triggerRef,
              'aria-label': t('indicator.title'), 'aria-controls': popoverId,
              'aria-expanded': expanded, 'aria-haspopup': 'dialog',
              onPointerEnter: showPopover, onPointerLeave: scheduleHide,
              onFocus: showPopover, onBlur: scheduleHide, onClick: showPopover,
              onKeyDown: event => { if (event.key === 'Escape') hidePopover() },
            }, h('span', { className: 'ptcPlusActiveLabel' }, 'PTC Plus')),
            h(ReplMemoryCard, {
              memory, t, id: popoverId, titleId, popoverRef,
              onEnter: showPopover, onLeave: scheduleHide,
            }))
        }
        scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
          name: 'conversation.session.header.actions', id: 'ptc-plus-active', order: -9, locale: LOCALE_NS,
        }, PTCPlusSessionIndicator))
      })
    }

    module.exports = { apply, inject: ['settingsScope', 'slots', 'sessions', 'locale'] }
    return module.exports
  },
})
