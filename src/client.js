import { CONFIG_FIELDS, CONFIG_GROUPS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { derivePtcToolView } from './client-activity.js'
import { createTypeScriptEditor } from './client-code-editor.js'
import { createBindingConsole } from './client-console.js'
import {
  isIdleSessionComposer,
  sessionUsesPtcPreset,
  useSessionPreset,
  watchCurrentSessionPreset,
} from './client-host-compat.js'
import {
  normalizeReplMemorySnapshot,
  unavailableReplMemorySnapshot,
} from '../internal/repl-memory-projection.js'
import { normalizeUserBindingDraftView } from '../internal/user-binding-draft-projection.js'
import { bindingModelPreferences } from '../internal/user-binding-model-context.js'

const CLIENT_STYLE_ID = 'ptc-plus-client-style'
const USER_BINDINGS_RPC_CHANNEL = '/ptc-plus-bindings'
const CLIENT_CSS = `
.ptcPlusBindingCommand .ptcPlusMessage{margin:0}.ptcPlusBindingSourceDetails{min-width:0}.ptcPlusBindingSourceDetails>summary{cursor:pointer;font-size:12px;line-height:20px}.ptcPlusBindingItem>button,.ptcPlusGlobalItem>button{align-self:center}.ptcPlusAuthoringDraft>strong{font-size:13px;line-height:20px;overflow-wrap:anywhere}.ptcPlusBindingCommand .ptcPlusBindingCommandState{max-width:100%;box-sizing:border-box;white-space:normal}.ptcPlusBindingCommand .ptcPlusAuthoringDraft{min-width:0;padding:0;border:0;border-radius:0;background:transparent}
.ptcPlusCard{list-style:none;border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;transition:border-color .16s ease,background-color .16s ease}
.ptcPlusCard:hover{border-color:var(--dsw-alias-label-dimmed)}
.ptcPlusCard[data-open=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:12px}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible,.ptcPlusSelect:focus-visible,.ptcPlusTextarea:focus-visible,.ptcPlusBindingSelect:focus-visible,.ptcPlusReplBindingTrigger:focus-visible,.ptcPlusReplInspect:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:3px}.ptcPlusName{font-size:15px;font-weight:600;line-height:1.4}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:1px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.ptcPlusGroup+.ptcPlusGroup{margin-top:20px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}.ptcPlusGroupTitle{margin:0;padding:8px 0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;letter-spacing:0;line-height:20px}.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:0.5px solid var(--dsw-alias-border-l2)}.ptcPlusGroupTitle+.ptcPlusRow{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:13px;font-weight:500;line-height:1.5}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}.ptcPlusInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:4px 14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:1.5;transition:color .16s ease,border-color .16s ease,background-color .16s ease}.ptcPlusButton:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}.ptcPlusButton[data-kind=primary]{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3)}.ptcPlusButton[data-kind=primary]:hover:not(:disabled){background:var(--dsw-alias-label-primary-dimmed);border-color:transparent;color:var(--dsw-alias-bg-layer-3)}.ptcPlusButton[data-kind=ghost]{border-color:transparent}.ptcPlusButton[data-kind=ghost]:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}.ptcPlusButton[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}.ptcPlusButton[data-kind=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.4}
.ptcPlusDanger{color:var(--dsw-alias-state-error-primary)}
.ptcPlusActiveShell{display:inline-flex;align-items:center}.ptcPlusActive{appearance:none;display:inline-flex;height:24px;align-items:center;gap:5px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 32%,transparent);border-radius:6px;background:var(--dsw-alias-state-success-tertiary,#e7f7ef);color:var(--dsw-alias-state-success-primary,#16794f);cursor:help;font-family:inherit;font-size:12px;font-weight:600;line-height:18px;white-space:nowrap;transition:background-color .14s ease,border-color .14s ease}.ptcPlusActive:hover,.ptcPlusActive[aria-expanded=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 16%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusActive:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary,#16794f);outline-offset:2px}.ptcPlusReplPopover{position:fixed;z-index:2147483000;inset:auto;display:none;box-sizing:border-box;margin:0;padding:0;border:0;overflow:visible;background:transparent;color:var(--dsw-alias-label-primary,#18191c)}.ptcPlusReplPopover:popover-open,.ptcPlusReplPopover[data-open=true]{display:block}.ptcPlusReplPopover::backdrop{background:transparent}.ptcPlusReplCard{display:flex;max-height:inherit;overflow:hidden;flex-direction:column;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 22%,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));border-top:3px solid var(--dsw-alias-state-success-primary,#16794f);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 14px 36px rgba(16,24,40,.2),0 3px 10px rgba(16,24,40,.1);color:var(--dsw-alias-label-primary,#18191c);white-space:normal}.ptcPlusReplHead{display:grid;flex:none;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:8px;padding:11px 13px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 7%,var(--dsw-alias-bg-layer-3,#fff))}.ptcPlusReplStatusDot{grid-row:1/3;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16794f);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794f) 14%,transparent)}.ptcPlusReplTitle,.ptcPlusReplSummary{display:block;min-width:0}.ptcPlusReplTitle{font-size:13px;font-weight:600;line-height:19px}.ptcPlusReplSummary{min-height:16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:16px}.ptcPlusReplList{min-height:0;margin:0;padding:5px 0;overflow:auto;overscroll-behavior:contain;list-style:none;scrollbar-gutter:stable}.ptcPlusReplBinding{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 10px;padding:7px 12px}.ptcPlusReplBinding:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusReplIdentity{display:flex;min-width:0;align-items:center;gap:7px}.ptcPlusReplName{min-width:0;overflow:hidden;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplKind{flex:none;padding:1px 6px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:10px;font-weight:600;line-height:15px}.ptcPlusReplKind[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplKind[data-kind=function]{color:#7651b5}.ptcPlusReplKind[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplKind[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusReplInspect{grid-column:2;grid-row:1/3;display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;font:500 11px/17px inherit;white-space:nowrap}.ptcPlusReplInspect:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusReplInspect:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:1px}.ptcPlusReplDefinition{grid-column:1/-1;min-width:0;margin-top:4px;padding:8px;border-left:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusReplLocation{display:block;margin-bottom:5px;color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;line-height:15px}.ptcPlusReplCode{max-height:180px;margin:0;overflow:auto;color:inherit;font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusReplEmpty,.ptcPlusReplMore{display:block;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusReplEmpty{padding:18px 13px;font-size:12px;line-height:18px}.ptcPlusReplMore{padding:8px 13px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03));font-size:11px;line-height:17px}
.ptcPlusReplTabs{display:flex;flex:none;padding:6px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusReplTab{flex:1;padding:5px 6px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;line-height:17px}.ptcPlusReplTab[aria-selected=true]{border-bottom-color:var(--dsw-alias-interactive-primary,#4d6bfe);color:var(--dsw-alias-label-primary,#18191c)}.ptcPlusGlobalPane{display:flex;min-height:0;flex-direction:column;gap:8px;padding:8px 12px}.ptcPlusGlobalList{min-height:0;margin:0 -12px -8px;padding:5px 0;overflow:auto;list-style:none}.ptcPlusGlobalItem{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;padding:7px 12px;border-radius:8px}.ptcPlusGlobalItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusGlobalItem .ptcPlusGlobalSource,.ptcPlusGlobalItem .ptcPlusReplEmpty{grid-column:1/-1}.ptcPlusAuthoringDraft{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}.ptcPlusGlobalSource{max-height:180px;margin:6px 0 0;padding:8px 10px;overflow:auto;background:var(--dsw-alias-markdown-code-block);border-radius:8px;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.ptcPlusReplList{max-height:min(52vh,480px)}.ptcPlusReplBinding{grid-template-columns:minmax(0,1fr) 24px;gap:3px 8px;min-height:36px;padding:5px 12px;content-visibility:auto;contain-intrinsic-size:36px;cursor:pointer;transition:background-color .16s ease}.ptcPlusReplBinding:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}.ptcPlusReplBinding[data-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 5%,transparent)}.ptcPlusReplName{grid-column:1}.ptcPlusReplName[data-kind=variable]{color:var(--dsw-alias-interactive-primary,#315fbd)}.ptcPlusReplName[data-kind=function]{color:#7651b5}.ptcPlusReplName[data-kind=class]{color:var(--dsw-alias-state-warning-primary,#946200)}.ptcPlusReplName[data-kind=import]{color:#14766f}.ptcPlusReplPreview{grid-column:1}.ptcPlusReplChevron{grid-column:2;grid-row:1/3;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .2s ease}.ptcPlusReplChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusReplDefinitionWrap{grid-column:1/-1;display:grid;grid-template-rows:0fr;min-width:0;transition:grid-template-rows .24s cubic-bezier(.2,.7,.2,1)}.ptcPlusReplDefinitionWrap[data-open=true]{grid-template-rows:1fr}.ptcPlusReplDefinitionInner{min-height:0;overflow:hidden}
.ptcPlusTool{display:flex;min-width:0;flex-direction:column}.ptcPlusToolPreview{display:flex;min-width:0;flex:1 1 auto;flex-direction:row;align-items:center;overflow:hidden;margin-left:7px}.ptcPlusToolPreview .ptcPlusFeatures{flex:0 1 auto;flex-wrap:nowrap;overflow:hidden;margin:0 0 0 7px}.ptcPlusToolSummaryLine{box-sizing:border-box;display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary{box-sizing:border-box;display:flex;min-width:0;min-height:32px;align-items:center;gap:7px;padding:0;color:inherit;line-height:20px}.ptcPlusToolSummary[data-expandable=true]{cursor:pointer}.ptcPlusToolSummary[data-expandable=true]:hover .ptcPlusToolTitle{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:2px}.ptcPlusToolLeading{display:flex;width:16px;height:20px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolChevron{transition:transform .16s ease}.ptcPlusToolChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusToolTitle{display:flex;height:20px;flex:none;align-items:center;font-size:13px;font-weight:500;line-height:20px}.ptcPlusToolState{display:flex;height:20px;flex:none;align-items:center;color:var(--dsw-alias-label-tertiary,#74777d);font-size:11px;line-height:20px}.ptcPlusToolSummaryLine[data-state=running] .ptcPlusToolState,.ptcPlusToolSummary[data-state=running] .ptcPlusToolState{color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolState,.ptcPlusToolSummary[data-state=error] .ptcPlusToolState{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolState,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolState{color:var(--dsw-alias-state-warning-primary,#a15c00)}.ptcPlusToolSep{width:3px;height:3px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#74777d)}.ptcPlusToolDescription{display:flex;min-width:0;min-height:20px;flex:1 1 auto;align-items:center;overflow:hidden;color:var(--dsw-alias-label-secondary,#52565d);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeature{flex:none;max-width:180px;white-space:nowrap}.ptcPlusToolPreview .ptcPlusFeatureDetail{max-width:120px}.ptcPlusToolSummaryLine[data-state=error] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=error] .ptcPlusToolDescription{color:var(--dsw-alias-state-danger-primary,#c43d3d)}.ptcPlusToolSummaryLine[data-state=stopped] .ptcPlusToolDescription,.ptcPlusToolSummary[data-state=stopped] .ptcPlusToolDescription{color:var(--dsw-alias-state-warning-primary,#a15c00)}
.ptcPlusFeatures{display:flex;min-width:0;flex-wrap:wrap;gap:3px 14px;margin:0 0 5px 23px}.ptcPlusFeature{display:inline-flex;min-width:0;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;line-height:17px}.ptcPlusFeature::before{width:4px;height:4px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-primary,#4d6bfe);content:''}.ptcPlusFeatureName{font-weight:500}.ptcPlusFeatureDetail{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary,#74777d);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.ptcPlusToolBody{margin:4px 0 8px 23px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.03))}.ptcPlusToolSection{display:flex;min-width:0;flex-direction:column;gap:4px;padding:9px 11px}.ptcPlusToolSection+.ptcPlusToolSection{border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusToolSectionLabel{color:var(--dsw-alias-label-tertiary,#74777d);font-size:10px;font-weight:600;line-height:16px;text-transform:uppercase}.ptcPlusToolCode{max-height:320px;margin:0;overflow:auto;color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoCard{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-markdown-code-block,rgba(38,49,72,.06));overflow:hidden}.ptcPlusIoText{max-height:320px;margin:0;padding:12px 16px;overflow:auto;color:var(--dsw-alias-label-secondary,#52565d);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusIoText[data-error]{color:var(--dsw-alias-state-error-primary,#c43d3d)}.ptcPlusInspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer;opacity:0;font-size:11px;line-height:16px;transition:opacity .1s ease;display:inline-flex}.ptcPlusTool:hover .ptcPlusInspect,.ptcPlusInspect:focus-visible{opacity:1}.ptcPlusInspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#18191c)}
.ptcPlusAuthorButtonShell{display:inline-flex;width:28px;height:28px;flex:none;align-items:center;justify-content:center}.ptcPlusAuthorButton{appearance:none;display:inline-flex;box-sizing:border-box;width:28px;height:28px;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#52565d);cursor:pointer}.ptcPlusAuthorButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusAuthorButton:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:1px}.ptcPlusAuthorButtonShell[data-text=true]{width:auto}.ptcPlusAuthorButtonLabel{padding:0 4px;font-size:12px;line-height:18px;font-weight:500}.ptcPlusComposerNotice{max-width:160px;color:var(--dsw-alias-label-secondary,#52565d);font-size:11px;line-height:17px;overflow-wrap:anywhere}.ptcPlusButton>svg{flex:none;margin-right:5px;vertical-align:-2px}
@media(max-width:760px){.ptcPlusBindingsGrid{grid-template-columns:1fr}.ptcPlusBindingFields{grid-template-columns:1fr}.ptcPlusBindingField[data-wide=true]{grid-column:auto}.ptcPlusBindingSourceGrid{grid-template-columns:1fr}.ptcPlusBindingDebugBody{grid-template-columns:1fr}.ptcPlusBindingDebugBody .ptcPlusButton{width:100%}.ptcPlusBindingDebugWarning{grid-column:1}}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter,.ptcPlusBindingsHead{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}.ptcPlusFeatures,.ptcPlusToolBody{margin-left:0}.ptcPlusToolSummary .ptcPlusToolDescription{white-space:normal;overflow-wrap:anywhere}}
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
@media(max-width:560px){.ptcPlusActive{width:28px;flex:none;padding:0}.ptcPlusActiveLabel{display:none}}
`

const BINDING_WORKBENCH_CSS = `
.ptcPlusBindings{margin-top:16px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}.ptcPlusBindingsHead{display:flex;align-items:center;justify-content:space-between;gap:12px}.ptcPlusBindingsTitle{margin:0;font-size:15px;font-weight:600;line-height:1.4}.ptcPlusBindingsActions{display:flex;flex-wrap:wrap;gap:8px}.ptcPlusBindingsGrid{display:grid;grid-template-columns:minmax(240px,.7fr) minmax(340px,1.3fr);gap:12px;margin-top:12px;align-items:start}.ptcPlusBindingPane{display:flex;min-width:0;flex-direction:column;gap:8px}
.ptcPlusBindingList{display:flex;min-width:0;margin:0;padding:8px;flex-direction:column;gap:2px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);list-style:none}.ptcPlusBindingItem{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:6px 8px;border-radius:8px;transition:background-color .12s ease}.ptcPlusBindingItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusBindingItem[data-selected=true]{background:var(--dsw-alias-bg-module-platform)}.ptcPlusBindingSelect{display:flex;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusBindingSelect:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.ptcPlusBindingName{display:block;min-width:0;max-width:100%;overflow:hidden;font:500 13px/20px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.ptcPlusBindingMeta{display:block;min-width:0;max-width:100%;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}.ptcPlusBindingState{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;corner-shape:round;font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}.ptcPlusBindingState[data-enabled=true]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}.ptcPlusBindingState[data-enabled=false]{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}.ptcPlusBindingStateDot{width:6px;height:6px;border-radius:50%;background:currentColor}.ptcPlusBindingToggle{grid-column:2;grid-row:1/3;align-self:center;justify-self:end;min-height:26px;padding:2px 10px;font-size:12px;line-height:17px;border-radius:999px;corner-shape:round}.ptcPlusBindingRun{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}.ptcPlusBindingRun .ptcPlusInput{flex:1;min-width:160px;width:auto}
.ptcPlusBindingEditor{display:flex;min-width:0;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}.ptcPlusBindingSection{display:flex;min-width:0;flex-direction:column;gap:12px;padding:14px 16px}.ptcPlusBindingSection+.ptcPlusBindingSection{border-top:0.5px solid var(--dsw-alias-border-l2)}.ptcPlusBindingSectionTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}.ptcPlusBindingFields{display:grid;min-width:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}.ptcPlusBindingField{display:flex;min-width:0;flex-direction:column;gap:5px}.ptcPlusBindingField[data-wide=true]{grid-column:1/-1}.ptcPlusBindingFieldLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}.ptcPlusBindingEditor .ptcPlusInput,.ptcPlusSelect{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}.ptcPlusBindingEditor .ptcPlusInput:focus-visible,.ptcPlusSelect:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.ptcPlusTextarea{box-sizing:border-box;width:100%;min-height:220px;resize:vertical;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}.ptcPlusTextarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.ptcPlusDeclaration{box-sizing:border-box;max-height:220px;margin:0;padding:12px;overflow:auto;background:var(--dsw-alias-markdown-code-block);border-radius:12px;color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusBindingSourceGrid{display:grid;min-width:0;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.ptcPlusBindingSourceEditor,.ptcPlusBindingSourcePreview{display:flex;min-width:0;flex-direction:column;gap:6px}.ptcPlusBindingSourcePreview .ptcPlusCodeBlock{max-height:220px;overflow:auto}
.ptcPlusBindingLifecycle{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}.ptcPlusBindingDebug{display:flex;min-width:0;flex-direction:column;gap:10px;padding:12px 16px;border-top:0.5px solid var(--dsw-alias-border-l2)}.ptcPlusBindingDebugSummary{display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:1.5;list-style:none}.ptcPlusBindingDebugSummary::-webkit-details-marker{display:none}.ptcPlusBindingDebugSummary::after{content:'';width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .16s ease}.ptcPlusBindingDebug[open] .ptcPlusBindingDebugSummary::after{transform:rotate(-135deg)}.ptcPlusBindingDebugBody{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:end;gap:10px}.ptcPlusBindingDebugBody .ptcPlusBindingField{min-width:0}.ptcPlusBindingDebugBody .ptcPlusButton{align-self:end}.ptcPlusBindingDebugWarning{grid-column:1/-1;color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:1.5}.ptcPlusBindingOutput{grid-column:1/-1;margin:0;padding:10px 12px;overflow:auto;background:var(--dsw-alias-markdown-code-block);border-radius:8px;color:var(--dsw-alias-label-secondary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.ptcPlusBindingCommand{display:flex;min-width:0;flex-direction:column;gap:6px;margin:6px 0 10px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}.ptcPlusBindingCommandHeader{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:8px}.ptcPlusBindingCommandTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}.ptcPlusBindingCommandState{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}.ptcPlusBindingCommand[data-phase=pending] .ptcPlusBindingCommandState{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}.ptcPlusBindingCommand[data-phase=ready] .ptcPlusBindingCommandState{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}.ptcPlusBindingCommand[data-phase=failed] .ptcPlusBindingCommandState{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.ptcPlusBindingCommandStateDot{width:6px;height:6px;border-radius:50%;background:currentColor}.ptcPlusBindingCommandRequirement{margin:0;overflow:auto;color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusBindingCommandSource{max-height:280px;margin:0;padding:10px 12px;overflow:auto;background:var(--dsw-alias-markdown-code-block);border-radius:8px;color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusBindingCommandCode{max-height:300px;overflow:auto}.ptcPlusBindingCommandActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}

`

const REPL_CONSOLE_CSS = `
.ptcPlusBindingsSurface .ptcPlusBindingSection.ptcPlusModelPrompt{padding:12px 0}.ptcPlusModelPrompt .ptcPlusBindingSectionTitle{margin:0 0 10px}.ptcPlusModelPrompt textarea.ptcPlusInput{height:auto;min-height:80px;padding:8px 12px;resize:vertical}.ptcPlusModelPrompt .ptcPlusPromptToggle{flex-direction:row;align-items:center;justify-content:space-between;cursor:pointer}.ptcPlusModelPrompt .ptcPlusCheck{flex:none}.ptcPlusEditorHead .ptcPlusBindingLifecycle{min-width:0}.ptcPlusEditorHead .ptcPlusButton{width:auto}
.ptcPlusConsole{box-sizing:border-box;flex:1;min-width:0;min-height:0;width:100%;height:100%;overflow:auto;padding:20px 24px;color:var(--dsw-alias-label-primary);container-type:inline-size}
.ptcPlusConsoleSection{min-width:0}.ptcPlusConsoleSection+.ptcPlusConsoleSection{margin-top:22px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2)}
.ptcPlusObservationHead,.ptcPlusObservationTitle{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.ptcPlusObservationHead{justify-content:space-between;margin-bottom:14px}
.ptcPlusObservationTitle h2{margin:0;font-size:15px;font-weight:600;line-height:22px}.ptcPlusObservationCount{font-size:13px;color:var(--dsw-alias-label-tertiary)}.ptcPlusObservationTime{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ptcPlusObservationGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.ptcPlusObservationCatalog{min-width:0}
.ptcPlusObservationFilters{display:flex;gap:10px;align-items:center;margin-bottom:8px}.ptcPlusObservationFilters>.ptcPlusSelect{width:120px;height:32px;flex:none;font-size:12px}
.ptcPlusSearch{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-width:0;flex:1;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-tertiary)}
.ptcPlusSearch>svg{flex:none}.ptcPlusSearch input{min-width:0;width:100%;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:12px/20px inherit}.ptcPlusSearch:focus-within{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:1px}
.ptcPlusObservations{height:256px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
.ptcPlusObservationTable{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:12px;text-align:left}.ptcPlusObservationTable th{position:sticky;top:0;z-index:1;height:32px;padding:0 10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ptcPlusObservationTable th:first-child{width:34%}.ptcPlusObservationTable th:nth-child(2){width:16%}.ptcPlusObservationTable td{height:34px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow:hidden}.ptcPlusObservationTable tr:last-child td{border-bottom:0}.ptcPlusObservationTable tbody tr{cursor:pointer}.ptcPlusObservationTable tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusObservationTable tr[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 7%,transparent)}
.ptcPlusObservationSelect{display:block;width:100%;min-width:0;height:34px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusObservationKind{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ptcPlusObservationValue{display:flex;min-width:0;align-items:center;gap:6px}.ptcPlusObservationValue code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusObservationState{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.ptcPlusObservationValue .ptcPlusObservationState{flex:none}.ptcPlusObservationEmpty{padding:12px}
.ptcPlusBindingInspector{box-sizing:border-box;min-width:0;max-height:296px;overflow:auto;padding-left:24px;border-left:1px solid var(--dsw-alias-border-l2)}
.ptcPlusInspectorHead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 12px;margin:0 0 12px}.ptcPlusInspectorHead strong{min-width:0;overflow-wrap:anywhere;font:600 13px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusInspectorHead span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ptcPlusObservationLabel{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ptcPlusObservationCode{max-height:184px;margin:0;overflow:auto;border-radius:6px;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ptcPlusObservationPreview{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusObservationUnavailable{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ptcPlusBindingsSurface{min-width:0;container-type:inline-size}.ptcPlusBindingsSurface .ptcPlusBindings{margin:0;padding:0;border:0}.ptcPlusBindingsSurface .ptcPlusBindingsGrid{grid-template-columns:220px minmax(0,1fr);gap:20px;margin-top:12px}.ptcPlusBindingsSurface .ptcPlusBindingsTitle{font-size:15px;line-height:22px}
.ptcPlusBindingPane{min-width:0}.ptcPlusBindingPane>.ptcPlusSearch{flex:none;margin-bottom:2px}.ptcPlusBindingsSurface .ptcPlusBindingsHead{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px}.ptcPlusBindingsSurface .ptcPlusBindingList{max-height:350px;overflow:auto;gap:0;padding:0;border:0;border-radius:0;background:transparent}.ptcPlusBindingsSurface .ptcPlusBindingItem{min-height:52px;padding:8px;border-radius:4px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2)}.ptcPlusBindingsSurface .ptcPlusBindingItem[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#4d6bfe) 7%,transparent)}
.ptcPlusBindingsSurface .ptcPlusBindingName{font-size:12px;font-weight:500;white-space:normal;overflow-wrap:anywhere}.ptcPlusBindingsSurface .ptcPlusBindingMeta{font-size:11px;line-height:16px}.ptcPlusBindingsSurface .ptcPlusBindingEditor{border:0;border-radius:0;background:transparent;overflow:visible}
.ptcPlusBindingSwitch{appearance:none;position:relative;align-self:center;flex:none;width:30px;height:18px;padding:2px;border:0;border-radius:9px;background:var(--dsw-alias-label-dimmed,#a5a7ad);cursor:pointer}.ptcPlusBindingSwitch span{display:block;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .15s ease}.ptcPlusBindingSwitch[aria-checked=true]{background:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusBindingSwitch[aria-checked=true] span{transform:translateX(12px)}.ptcPlusBindingSwitch:disabled{cursor:not-allowed;opacity:.5}
.ptcPlusEditorHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;min-height:32px;margin-bottom:8px}.ptcPlusEditorFile{min-width:0;overflow-wrap:anywhere;font:600 13px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusBindingLifecycle{gap:6px}
.ptcPlusIconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.ptcPlusIconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusIconButton[data-kind=danger]:hover{color:var(--dsw-alias-state-error-primary)}.ptcPlusIconButton:disabled{opacity:.4;cursor:not-allowed}
.ptcPlusCodeEditor{min-width:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;--ptc-code-keyword:color-mix(in srgb,#a13d96 75%,var(--dsw-alias-label-primary));--ptc-code-string:color-mix(in srgb,#af643c 75%,var(--dsw-alias-label-primary));--ptc-code-number:color-mix(in srgb,#477ac2 75%,var(--dsw-alias-label-primary));--ptc-code-type:color-mix(in srgb,#258579 75%,var(--dsw-alias-label-primary));--ptc-code-function:color-mix(in srgb,#825bbe 75%,var(--dsw-alias-label-primary))}.ptcPlusCodeEditor:focus-within{border-color:var(--dsw-alias-interactive-primary,#4d6bfe)}.ptcPlusCodeEditor .cm-editor{height:336px}.ptcPlusCodeEditor .cm-scroller{min-height:0}.ptcPlusCodeEditor .cm-line{overflow-wrap:anywhere}
.ptcPlusBindingsSurface .ptcPlusBindingSection{display:block;padding:0;margin-top:0;border:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.ptcPlusBindingSection>summary,.ptcPlusBindingsSurface .ptcPlusBindingDebugSummary{padding:11px 0;cursor:pointer;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.ptcPlusEntrySettings .ptcPlusBindingFields{padding:0 0 14px}.ptcPlusBindingsSurface .ptcPlusBindingSourcePreview{display:block}.ptcPlusBindingSourcePreview>.ptcPlusCodeBlock{margin-bottom:12px}.ptcPlusBindingsSurface .ptcPlusBindingDebug{display:block;padding:0;border-top:0}.ptcPlusBindingsSurface .ptcPlusBindingDebugBody{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding-bottom:12px}
.ptcPlusBindingsSurface .ptcPlusBindingRun{gap:6px;margin-top:10px}.ptcPlusBindingsSurface .ptcPlusBindingRun .ptcPlusInput{flex-basis:100%;min-width:0;width:100%;height:32px;font-size:12px}.ptcPlusBindingsSurface .ptcPlusMessage[role=status]{grid-column:1/-1;margin:0}
.ptcPlusSessionEmpty{box-sizing:border-box;width:100%;padding:16px 18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}.ptcPlusObservationGrid[data-empty=true]{grid-template-columns:minmax(0,1fr)}.ptcPlusObservationGrid[data-empty=true] .ptcPlusObservations{height:auto;min-height:94px}
.ptcPlusSourceSection{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}.ptcPlusSourceToggle{display:flex;min-width:0;align-items:center;gap:6px;padding:12px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;font:500 12px/20px inherit}.ptcPlusSourceToggle svg{flex:none}.ptcPlusSourceFilename{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:11px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusSourceActions{display:flex;flex-wrap:wrap;gap:6px;padding:6px 0}.ptcPlusSourceBody{grid-column:1/-1;min-width:0;margin-bottom:12px}.ptcPlusSourceCode{max-height:336px;overflow:auto;margin:0;border-radius:6px;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.ptcPlusWorkbenchFeedback{min-height:22px;padding:4px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusBindings[aria-busy=true] button:disabled,.ptcPlusBindings[aria-busy=true] input:disabled{opacity:1}.ptcPlusBindings[aria-busy=true] button:disabled{cursor:wait}
.ptcPlusExecution{min-width:0;margin:0 0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}.ptcPlusExecution>summary{padding:10px 12px;cursor:pointer;font-size:12px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary)}.ptcPlusExecutionToolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}.ptcPlusExecutionLanguage{font:11px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary)}.ptcPlusExecutionState{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.ptcPlusExecutionActions{display:flex;align-items:center;gap:6px;margin-left:auto}.ptcPlusExecutionActions .ptcPlusButton{min-width:68px;min-height:30px;padding:3px 10px;font-size:12px}
.ptcPlusExecutionHistory{min-height:48px;max-height:320px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.ptcPlusExecutionHistory:empty{min-height:0}.ptcPlusExecutionRecord{min-width:0;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}.ptcPlusExecutionCommand,.ptcPlusExecutionOutput{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusExecutionCommand{color:var(--dsw-alias-label-secondary)}.ptcPlusExecutionCommand>span{color:var(--dsw-alias-label-tertiary)}.ptcPlusExecutionResult{flex-direction:row;gap:12px;margin-top:8px;padding:12px 16px}.ptcPlusExecutionOutputLabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}.ptcPlusExecutionOutput{flex:1;min-width:0;max-height:240px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;color:var(--dsw-alias-label-secondary)}.ptcPlusExecutionOutput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary);outline-offset:-2px}.ptcPlusExecutionOutput[data-error=true]{color:var(--dsw-alias-state-error-primary)}.ptcPlusExecutionDuration{display:block;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}.ptcPlusExecutionInput .ptcPlusCodeEditor{border:0;border-radius:0}.ptcPlusExecutionInput .cm-editor{height:108px}.ptcPlusExecutionInput .cm-content{min-height:88px}
@container(max-width:460px){.ptcPlusSourceSection{grid-template-columns:minmax(0,1fr)}.ptcPlusSourceToggle{padding-bottom:6px}.ptcPlusSourceActions{justify-content:flex-end}.ptcPlusExecutionToolbar{gap:6px;padding:8px}.ptcPlusExecutionActions{gap:4px}.ptcPlusSourceFilename{display:none}}
.ptcPlusBindingsModal.ptcPlusBindingsModal{width:min(1200px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 40px);border-radius:8px}.ptcPlusBindingsDialog{box-sizing:border-box;max-height:calc(100dvh - 40px);overflow:auto;padding:24px}.ptcPlusBindingsDialogHead{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.ptcPlusBindingsDialogHead h2{margin:0;font-size:17px;line-height:24px}.ptcPlusDialogClose{display:flex;flex:none;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}.ptcPlusDialogClose:hover{background:var(--dsw-alias-interactive-bg-hover)}.ptcPlusConsole button:focus-visible,.ptcPlusBindingsDialog button:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary);outline-offset:-2px}
@container(max-width:780px){.ptcPlusObservationGrid{grid-template-columns:minmax(0,1fr);gap:16px}.ptcPlusBindingInspector{max-height:none;padding:12px 0 0;border-left:0;border-top:1px solid var(--dsw-alias-border-l2)}.ptcPlusObservations{height:200px}.ptcPlusBindingsSurface .ptcPlusBindingsGrid{grid-template-columns:minmax(0,1fr);gap:18px}.ptcPlusBindingsSurface .ptcPlusBindingList{max-height:180px}.ptcPlusBindingsSurface .ptcPlusBindingFields,.ptcPlusBindingsSurface .ptcPlusBindingDebugBody{grid-template-columns:minmax(0,1fr)}.ptcPlusObservationTable th:first-child{width:35%}.ptcPlusObservationTable th:nth-child(2){width:64px}}
@media(max-width:560px){.ptcPlusConsole{padding:14px 12px}.ptcPlusBindingsModal.ptcPlusBindingsModal{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.ptcPlusBindingsDialog{padding:16px;max-height:calc(100dvh - 16px)}.ptcPlusObservationFilters>.ptcPlusSelect{width:105px}.ptcPlusObservationTable th,.ptcPlusObservationTable td{padding:0 6px}.ptcPlusObservationValue{gap:3px}.ptcPlusObservationState{font-size:10px}.ptcPlusEditorHead{align-items:flex-start}.ptcPlusEditorHead>.ptcPlusBindingLifecycle{margin-left:auto}.ptcPlusSourceBody .cm-editor{height:300px}}
`

/** Locale namespace owning every settings-card string (field copy plus chrome). */
const LOCALE_NS = 'settings.ptcPlus'

/** Card chrome copy; field labels and hints ride the shared config spec. */
const CHROME_COPY = Object.freeze({
  zh: Object.freeze({
    'console.session': '会话绑定',
    'console.global': '全局绑定',
    'console.definition': '定义',
    'console.name': '名称',
    'console.kind': '类型',
    'console.search': '搜索绑定名称',
    'console.allKinds': '全部类型',
    'console.noMatches': '没有匹配的绑定',
    'bindings.search': '搜索全局条目',
    'console.value': '值预览',
    'console.observed': '结算后观察：{time}',
    'console.unobserved': '尚无值观察记录',
    'console.unreadable': '不可读取',
    'console.bounded': '已截断',
    'bindings.manage': '管理全局绑定',
    'bindings.entry': '条目配置',
    'bindings.close': '关闭全局绑定工作台',
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
    'bindings.title': '全局用户绑定',
    'bindings.reload': '重新加载',
    'bindings.new': '新建条目',
    'bindings.empty': '尚无全局条目',
    'bindings.loading': '正在加载全局用户绑定...',
    'bindings.disabled': '开启“全局用户绑定”后可管理 TypeScript 工具。',
    'bindings.name': '名称',
    'bindings.id': '稳定 ID',
    'bindings.scope': '作用域',
    'bindings.symbols': '导出符号',
    'bindings.symbolsPlaceholder': '逗号分隔；留空则从源码推导',
    'bindings.purpose': '用途',
    'bindings.source': 'TypeScript 源码',
    'bindings.sourcePreview': '实现源码',
    'bindings.declaration': '接口声明',
    'bindings.modelContext': '模型上下文',
    'bindings.includeDeclaration': '将接口声明提供给模型',
    'bindings.instructions': '给模型的提示词',
    'bindings.noInstructions': '未设置提示词',
    'bindings.lifecycle': '条目操作',
    'bindings.debug': '代码控制台',
    'bindings.edit': '编辑',
    'bindings.cancel': '取消',
    'bindings.unvalidated': '尚未验证当前草稿',
    'bindings.working': '正在处理...',
    'bindings.enabled': '启用',
    'bindings.disabledEntry': '停用',
    'bindings.enableAction': '启用',
    'bindings.disableAction': '停用',
    'bindings.stateEnabled': '当前已启用',
    'bindings.stateDisabled': '当前已停用',
    'bindings.validate': '验证',
    'bindings.save': '保存',
    'bindings.remove': '删除',
    'bindings.importPath': '本地 .ts 路径',
    'bindings.import': '导入',
    'bindings.run': '运行',
    'execution.ready': '就绪',
    'execution.running': '运行中',
    'execution.released': '环境已释放',
    'execution.stopped': '已停止，环境已释放',
    'execution.stop': '停止',
    'execution.reset': '重置环境',
    'execution.clear': '清空记录',
    'execution.history': '执行记录',
    'execution.output': '输出',
    'execution.input': 'TypeScript 命令',
    'execution.restarted': '已从当前草稿重新开始',
    'execution.truncated': '记录已截断',
    'bindings.saved': '条目已保存；从下一次 run_code 请求生效。',
    'bindings.valid': '源码与派生声明有效。',
    'bindings.removed': '条目已删除。',
    'bindings.imported': '源码已导入为停用条目。',
    'bindings.reloaded': '已从磁盘重新加载。',
    'bindings.reloadedDraft': '目录已重新加载，未保存的编辑已保留。',
    'bindings.reloadConflict': '读取期间目录再次发生变化，请重新加载。',
    'bindings.failed': '全局用户绑定操作失败：{error}',
    'bindings.authorNew': '让 Agent 编写',
    'bindings.authorEdit': 'Agent 修改',
    'bindings.authorOpen': '让 Agent 编写全局用户绑定',
    'bindings.composerBusy': '输入框已有内容，未覆盖现有草稿。',
    'bindings.draftTitle': 'Agent 草稿',
    'bindings.draftSave': '保存为停用',
    'bindings.draftSaveEnable': '保存并启用',
    'bindings.draftDiscard': '丢弃草稿',
    'bindings.commandTitle': '绑定编写',
    'bindings.commandPending': 'Agent 正在编写草稿...',
    'bindings.commandReady': '草稿已生成，可保存或丢弃',
    'bindings.commandFailed': '未生成可保存的草稿',
    'bindings.commandSaved': '草稿已保存为停用条目',
    'bindings.commandSavedEnabled': '草稿已保存并启用',
    'bindings.commandDiscarded': '草稿已丢弃',
    'bindings.commandUnavailable': '草稿已不可操作；保存状态未知',
    'bindings.draftSaved': 'Agent 草稿已保存为停用条目。',
    'bindings.draftPending': 'Agent 正在编写草稿...',
    'bindings.draftFailed': 'Agent 未生成可保存的草稿；请查看会话结果后重试。',
    'indicator.title': 'PTC Plus 已启用；查看当前可复用的 REPL 绑定',
    'memory.title': 'REPL 可复用绑定',
    'memory.count': '{count} 个可复用绑定',
    'memory.globalCount': '{count} 个全局条目',
    'memory.empty': '当前没有可复用绑定',
    'memory.unavailable': '当前绑定状态尚不可确认',
    'memory.more': '另有 {count} 个绑定未显示',
    'memory.kind.variable': '变量',
    'memory.kind.function': '函数',
    'memory.kind.class': '类',
    'memory.kind.import': '导入',
    'memory.location': '第 {line} 行，第 {column} 列',
    'memory.sessionTab': '可复用绑定',
    'memory.globalTab': '全局默认绑定',
    'memory.globalEmpty': '没有全局默认绑定',
    'memory.globalUnavailable': '无法读取全局默认绑定',
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
    'console.session': 'Session bindings',
    'console.global': 'Global bindings',
    'console.definition': 'Definition',
    'console.name': 'Name',
    'console.kind': 'Kind',
    'console.search': 'Search binding names',
    'console.allKinds': 'All kinds',
    'console.noMatches': 'No matching bindings',
    'bindings.search': 'Search global entries',
    'console.value': 'Value preview',
    'console.observed': 'Observed after settlement: {time}',
    'console.unobserved': 'No value observation yet',
    'console.unreadable': 'Unreadable',
    'console.bounded': 'Truncated',
    'bindings.manage': 'Manage global bindings',
    'bindings.entry': 'Entry configuration',
    'bindings.close': 'Close global bindings workbench',
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
    'bindings.title': 'Global User Bindings',
    'bindings.reload': 'Reload',
    'bindings.new': 'New entry',
    'bindings.empty': 'No global entries yet',
    'bindings.loading': 'Loading Global User Bindings...',
    'bindings.disabled': 'Enable Global User Bindings to manage TypeScript helpers.',
    'bindings.name': 'Name',
    'bindings.id': 'Stable ID',
    'bindings.scope': 'Scope',
    'bindings.symbols': 'Selected exports',
    'bindings.symbolsPlaceholder': 'Comma-separated; blank derives from source',
    'bindings.purpose': 'Purpose',
    'bindings.source': 'TypeScript source',
    'bindings.sourcePreview': 'Implementation source',
    'bindings.declaration': 'Interface declaration',
    'bindings.modelContext': 'Model context',
    'bindings.includeDeclaration': 'Include API declaration in model context',
    'bindings.instructions': 'Prompt for the model',
    'bindings.noInstructions': 'No prompt configured',
    'bindings.lifecycle': 'Entry actions',
    'bindings.debug': 'Code console',
    'bindings.edit': 'Edit',
    'bindings.cancel': 'Cancel',
    'bindings.unvalidated': 'Current draft has not been validated',
    'bindings.working': 'Working...',
    'bindings.enabled': 'Enabled',
    'bindings.disabledEntry': 'Disabled',
    'bindings.enableAction': 'Enable',
    'bindings.disableAction': 'Disable',
    'bindings.stateEnabled': 'Currently enabled',
    'bindings.stateDisabled': 'Currently disabled',
    'bindings.validate': 'Validate',
    'bindings.save': 'Save',
    'bindings.remove': 'Remove',
    'bindings.importPath': 'Local .ts path',
    'bindings.import': 'Import',
    'bindings.run': 'Run',
    'execution.ready': 'Ready',
    'execution.running': 'Running',
    'execution.released': 'Environment released',
    'execution.stopped': 'Stopped; environment released',
    'execution.stop': 'Stop',
    'execution.reset': 'Reset environment',
    'execution.clear': 'Clear history',
    'execution.history': 'Execution history',
    'execution.output': 'Output',
    'execution.input': 'TypeScript command',
    'execution.restarted': 'Started again from the current draft',
    'execution.truncated': 'Record truncated',
    'bindings.saved': 'Entry saved; it takes effect from the next run_code request.',
    'bindings.valid': 'Source and derived declaration are valid.',
    'bindings.removed': 'Entry removed.',
    'bindings.imported': 'Source imported as a disabled entry.',
    'bindings.reloaded': 'Reloaded from disk.',
    'bindings.reloadedDraft': 'Catalog reloaded; unsaved edits retained.',
    'bindings.reloadConflict': 'The catalog changed during reload. Reload again.',
    'bindings.failed': 'Global User Binding operation failed: {error}',
    'bindings.authorNew': 'Ask Agent to write',
    'bindings.authorEdit': 'Ask Agent to revise',
    'bindings.authorOpen': 'Ask Agent to write a Global User Binding',
    'bindings.composerBusy': 'The composer already has text, so its draft was not replaced.',
    'bindings.draftTitle': 'Agent draft',
    'bindings.draftSave': 'Save as disabled',
    'bindings.draftSaveEnable': 'Save and enable',
    'bindings.draftDiscard': 'Discard draft',
    'bindings.commandTitle': 'Binding authoring',
    'bindings.commandPending': 'Agent is writing a draft...',
    'bindings.commandReady': 'Draft ready to save or discard',
    'bindings.commandFailed': 'No saveable draft was produced',
    'bindings.commandSaved': 'Draft saved as a disabled entry',
    'bindings.commandSavedEnabled': 'Draft saved and enabled',
    'bindings.commandDiscarded': 'Draft discarded',
    'bindings.commandUnavailable': 'Draft unavailable; save status unknown',
    'bindings.draftSaved': 'Agent draft saved as a disabled entry.',
    'bindings.draftPending': 'The Agent is authoring a draft...',
    'bindings.draftFailed': 'The Agent did not produce a saveable draft; review the session result and try again.',
    'indicator.title': 'PTC Plus is active; view reusable REPL bindings',
    'memory.title': 'Reusable REPL bindings',
    'memory.count': '{count} reusable bindings',
    'memory.globalCount': '{count} global entries',
    'memory.empty': 'No reusable bindings',
    'memory.unavailable': 'Current binding state cannot be confirmed',
    'memory.more': '{count} more bindings not shown',
    'memory.kind.variable': 'Variable',
    'memory.kind.function': 'Function',
    'memory.kind.class': 'Class',
    'memory.kind.import': 'Import',
    'memory.location': 'Line {line}, column {column}',
    'memory.sessionTab': 'Reusable bindings',
    'memory.globalTab': 'Global defaults',
    'memory.globalEmpty': 'No global default bindings',
    'memory.globalUnavailable': 'Global default bindings are unavailable',
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
    ...Object.assign({}, ...CONFIG_GROUPS.map(group => ({
      [`group.${group.key}`]: locale === 'en' ? group.labelEn : group.label,
    }))),
    ...Object.assign({}, ...CONFIG_FIELDS.map(field => fieldCopy(field, locale))),
  })]),
))

window.__ModuleLoader__.load({
  // Replaced by the bundle entry with the package name from package.json.
  id: __PTC_PLUS_CLIENT_MODULE_ID__,
  factory: (require) => {
    const React = require('react')
    const {
      Button,
      CodeBlock,
      DisclosureRow,
      IconCheckOutline14,
      IconChevronDownOutline14,
      IconInspectOutline12,
      IconSparkle16,
      IconCloseOutline16,
      IconSearchOutline16,
      IconPlusOutline16,
      IconRefreshOutline16,
      IconTrashOutline16,
      IconEditOutline16,
      IconPlayOutline16,
      IconStopFill16,
      Modal,
      StateDot,
      Toast,
      Tooltip,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const module = { exports: {} }
    const h = React.createElement
    const TypeScriptEditor = createTypeScriptEditor(React)

    function IconButton({ icon: Icon, label, ...props }) {
      const button = h('button', { ...props, type: 'button', className: 'ptcPlusIconButton',
        'aria-label': label, title: label }, typeof Icon === 'function' ? h(Icon, { size: 16 }) : label)
      return typeof Tooltip === 'function' ? h(Tooltip, { label, delayMs: 400 }, button) : button
    }

    function ActionButton({ className = '', 'data-kind': kind, ...props }) {
      return typeof Button === 'function'
        ? h(Button, {
          ...props, size: 'sm', variant: kind === 'primary' ? 'primary' : kind === 'ghost' ? 'ghost' : 'outline',
          className: className.split(' ').filter(name => name !== 'ptcPlusButton').join(' '),
        })
        : h('button', { ...props, className, 'data-kind': kind })
    }

    const BindingConsole = createBindingConsole(React, { TypeScriptEditor, IconButton, ActionButton,
      icons: { play: IconPlayOutline16, stop: IconStopFill16, reset: IconRefreshOutline16, clear: IconTrashOutline16 } })

    function installStyles() {
      if (document.getElementById(CLIENT_STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = CLIENT_STYLE_ID
      style.textContent = `${CLIENT_CSS}${BINDING_WORKBENCH_CSS}${REPL_CONSOLE_CSS}`
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

      async function callUserBindings(endpoint, payload = {}, signal = undefined) {
        const settings = preferenceScope.getSnapshot()
        if (settings.status !== 'ready' || settings.value?.enabled !== true || settings.value?.userBindingsEnabled !== true) {
          throw new Error('Global User Bindings are disabled')
        }
        const result = await ctx.connection.rpc.call(
          USER_BINDINGS_RPC_CHANNEL,
          endpoint,
          payload,
          signal,
        )
        if (result?.ok === true) return result.value
        const error = new Error(result?.error?.message ?? 'Global User Binding request failed')
        if (typeof result?.error?.code === 'string') error.code = result.error.code
        throw error
      }

      function observeRepl(sessionId, element) {
        let controller
        let retryTimer
        let retries = 0
        let disposed = false
        const retryDelays = [1000, 2000, 4000]
        let visible = typeof IntersectionObserver !== 'function'
        const stop = () => {
          const previous = controller
          controller = undefined
          clearTimeout(retryTimer)
          retryTimer = undefined
          retries = 0
          previous?.abort()
        }
        const watch = async current => {
          try {
            await ctx.connection.rpc.call('/ptc-plus-repl', 'watch', { sessionId }, current.signal)
          } catch {}
          if (disposed || controller !== current) return
          controller = undefined
          current.abort()
          if (!visible || document.visibilityState === 'hidden') { stop(); return }
          const delay = retryDelays[retries++]
          if (delay === undefined) return
          retryTimer = setTimeout(() => { retryTimer = undefined; sync() }, delay)
        }
        const sync = () => {
          if (disposed) return
          const active = visible && document.visibilityState !== 'hidden'
          if (!active) { stop(); return }
          if (controller !== undefined || retryTimer !== undefined || retries > retryDelays.length) return
          controller = new AbortController()
          void watch(controller)
        }
        const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
          visible = entries.some(entry => entry.isIntersecting)
          sync()
        }) : undefined
        observer?.observe(element)
        const reset = ctx.on('connection/reset', () => { stop(); sync() })
        document.addEventListener('visibilitychange', sync)
        sync()
        return () => {
          disposed = true
          stop()
          observer?.disconnect()
          document.removeEventListener('visibilitychange', sync)
          reset()
        }
      }

      function createBindingCommandAvailability(scope) {
        const entries = new Map()
        const entryFor = (sessionId) => {
          const id = String(sessionId)
          let entry = entries.get(id)
          if (entry === undefined) {
            entry = { available: false, epoch: 0, listeners: new Set() }
            entry.source = {
              getSnapshot: () => entry.available,
              subscribe(listener) {
                entry.listeners.add(listener)
                if (entry.listeners.size === 1) void refresh(id)
                return () => {
                  entry.listeners.delete(listener)
                  if (entry.listeners.size === 0) {
                    entry.epoch++
                    entry.available = false
                  }
                }
              },
            }
            entries.set(id, entry)
          }
          return entry
        }
        const publish = (entry, available) => {
          if (entry.available === available) return
          entry.available = available
          for (const listener of entry.listeners) listener()
        }
        const refresh = async (sessionId) => {
          if (sessionId === undefined || sessionId === null) return
          const entry = entries.get(String(sessionId))
          if (entry === undefined || entry.listeners.size === 0) return
          const epoch = ++entry.epoch
          let available = false
          try {
            const result = await scope.remote.commands.list(String(sessionId))
            available = result?.ok === true
              && Array.isArray(result.value)
              && result.value.some(command => command?.name === 'binding')
          } catch {}
          if (entry.epoch === epoch) publish(entry, available)
        }
        const reset = (sessionId) => {
          if (sessionId === undefined || sessionId === null) return
          const entry = entries.get(String(sessionId))
          if (entry === undefined || entry.listeners.size === 0) return
          entry.epoch += 1
          publish(entry, false)
          void refresh(sessionId)
        }
        scope.effect(() => scope.remote.$on('commands/change', () => {
          for (const sessionId of entries.keys()) void refresh(sessionId)
        }))
        scope.effect(() => scope.remote.$on('agent-preset/selected', reset))
        scope.on('connection/reset', () => {
          for (const sessionId of entries.keys()) reset(sessionId)
        })
        scope.effect(() => () => {
          for (const entry of entries.values()) entry.epoch++
          entries.clear()
        })
        return Object.freeze({
          source: sessionId => entryFor(sessionId).source,
        })
      }

      const settingsProps = () => ({ hooks: { ptcSettings: preferenceScope }, callUserBindings })
      const updateSetting = async (key, value) => {
        const before = preferenceScope.getSnapshot()
        if (before.status !== 'ready' || before.writable !== true
          || (key !== 'enabled' && before.value?.enabled !== true)
          || before.value?.[key] === value) return null
        await preferenceScope.set(key, value)
        const after = preferenceScope.getSnapshot()
        return after.status === 'ready' && after.value?.[key] === value
          ? 'status.applied' : 'status.conflict'
      }
      const registerEnabled = (scope, bindings, register) => scope.effect(() => {
        let dispose
        const sync = () => {
          const snapshot = preferenceScope.getSnapshot()
          const enabled = snapshot.status === 'ready' && snapshot.value?.enabled === true
            && (!bindings || snapshot.value?.userBindingsEnabled === true)
          if (enabled === (dispose !== undefined)) return
          dispose?.()
          dispose = enabled ? register() : undefined
        }
        sync()
        const unsubscribe = preferenceScope.subscribe(sync)
        return () => { unsubscribe(); dispose?.() }
      })

      const blankBinding = () => ({
        id: '',
        name: '',
        scope: 'namespace',
        symbolsText: '',
        purpose: '',
        enabled: false,
        source: 'export function helper() {\n  return undefined\n}\n',
        modelContext: bindingModelPreferences(),
      })
      const editableBinding = value => ({
        id: value.id,
        name: value.name,
        scope: value.scope,
        symbolsText: Array.isArray(value.symbols) ? value.symbols.join(', ') : '',
        purpose: value.purpose,
        enabled: value.enabled,
        source: value.source,
        modelContext: bindingModelPreferences(value.modelContext),
      })
      const bindingPayload = (value) => {
        const { symbolsText, ...entry } = value
        const symbols = symbolsText.split(',').map(symbol => symbol.trim()).filter(Boolean)
        return symbols.length === 0 ? entry : { ...entry, symbols }
      }

      function UserBindingsWorkbench({ enabled, t, callUserBindings, heading = true, headingLabel }) {
        const [catalog, setCatalog] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [declaration, setDeclaration] = React.useState('')
        const [importPath, setImportPath] = React.useState('')
        const [original, setOriginal] = React.useState(null)
        const [editRevision, setEditRevision] = React.useState(null)
        const [editing, setEditing] = React.useState(false)
        const [sourceOpen, setSourceOpen] = React.useState(false)
        const [consoleVersion, setConsoleVersion] = React.useState(0)
        const [message, setMessage] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [catalogQuery, setCatalogQuery] = React.useState('')
        const [metadataOpen, setMetadataOpen] = React.useState(false)
        const requestGeneration = React.useRef(0)
        const operationActive = React.useRef(false)

        const fail = error => setMessage({
          key: 'bindings.failed',
          params: { error: error instanceof Error ? error.message : String(error) },
        })
        const refresh = React.useCallback(async (reload = false, signal = undefined) => {
          return callUserBindings(reload ? 'reload' : 'list', {}, signal)
        }, [])
        const showEntry = (loaded, { resetConsole = true } = {}) => {
          const entry = loaded?.entry ?? null
          if (resetConsole && draft?.source !== entry?.source) setConsoleVersion(current => current + 1)
          setDraft(entry === null ? null : editableBinding(entry))
          setOriginal(entry)
          setDeclaration(entry?.declaration ?? '')
          setEditRevision(loaded?.revision ?? null)
          setEditing(false)
        }
        React.useEffect(() => {
          requestGeneration.current += 1
          operationActive.current = false
          setBusy(false)
          showEntry(null)
          setCatalog(null)
          setMessage(null)
          if (!enabled) return undefined
          const controller = new AbortController()
          void perform(async current => {
            const next = await refresh(false, controller.signal)
            if (!current()) return
            setCatalog(next)
            if (next.entries[0]) {
              const loaded = await callUserBindings('load', { id: next.entries[0].id }, controller.signal)
              if (current()) showEntry(loaded)
            }
          })
          return () => { requestGeneration.current += 1; controller.abort() }
        }, [enabled, refresh])

        const perform = async operation => {
          if (operationActive.current) return
          operationActive.current = true
          const generation = ++requestGeneration.current
          const current = () => generation === requestGeneration.current
          setBusy(true)
          setMessage(null)
          try {
            await operation(current)
          } catch (error) {
            if (current()) fail(error)
          } finally {
            if (current()) { operationActive.current = false; setBusy(false) }
          }
        }
        const edit = (key, value) => {
          setDraft(current => ({ ...current, [key]: value }))
          setEditing(true)
          setMessage(null)
          if (key !== 'modelContext') setDeclaration('')
        }
        const load = id => perform(async current => {
          const loaded = await callUserBindings('load', { id })
          if (!current()) return
          showEntry(loaded)
          setSourceOpen(false)
          setMetadataOpen(false)
        })
        const reload = () => perform(async current => {
          const next = await refresh(true)
          if (!current()) return
          const selected = next.entries.find(entry => entry.id === original?.id)
          const loaded = selected === undefined ? null : await callUserBindings('load', { id: selected.id })
          if (!current()) return
          if (loaded !== null && loaded.revision !== next.revision) {
            setMessage({ key: 'bindings.reloadConflict' })
            return
          }
          setCatalog(next)
          if (editing) {
            setOriginal(loaded?.entry ?? null)
            setEditRevision(loaded?.revision ?? next.revision)
          } else showEntry(loaded)
          setMessage({ key: editing ? 'bindings.reloadedDraft' : 'bindings.reloaded' })
        })
        const validate = () => perform(async current => {
          const normalized = await callUserBindings('validate', { entry: bindingPayload(draft) })
          if (!current()) return
          setDraft(editableBinding(normalized))
          setDeclaration(normalized.declaration)
          setMessage({ key: 'bindings.valid' })
        })
        const save = () => perform(async current => {
          const normalized = await callUserBindings('validate', { entry: bindingPayload(draft) })
          if (!current()) return
          const next = await callUserBindings('save', {
            entry: bindingPayload(editableBinding(normalized)),
            expectedRevision: editRevision,
          })
          if (!current()) return
          setCatalog(next)
          setDraft(editableBinding(normalized))
          setDeclaration(normalized.declaration)
          setMessage({ key: 'bindings.saved' })
          if (original?.source !== normalized.source) setConsoleVersion(current => current + 1)
          setOriginal(normalized)
          setEditRevision(next.revision)
          setEditing(false)
          setSourceOpen(false)
        })
        const acceptCatalogMutation = next => {
          setCatalog(next)
          // A successful CAS on this baseline proves these metadata-only changes preserve its source.
          setEditRevision(current => current === catalog.revision ? next.revision : current)
        }
        const toggle = entry => perform(async current => {
          const next = await callUserBindings(entry.enabled ? 'disable' : 'enable', {
            id: entry.id,
            expectedRevision: catalog.revision,
          })
          if (!current()) return
          acceptCatalogMutation(next)
          if (draft?.id === entry.id) {
            setDraft(current => ({ ...current, enabled: !entry.enabled }))
            setOriginal(current => ({ ...current, enabled: !entry.enabled }))
          }
        })
        const remove = entry => perform(async current => {
          const next = await callUserBindings('remove', {
            id: entry.id,
            expectedRevision: catalog.revision,
          })
          if (!current()) return
          acceptCatalogMutation(next)
          if (draft?.id === entry.id) {
            showEntry(null)
          }
          setMessage({ key: 'bindings.removed' })
        })
        const importSource = () => perform(async current => {
          const next = await callUserBindings('import', {
            path: importPath,
            expectedRevision: catalog.revision,
          })
          if (!current()) return
          acceptCatalogMutation(next)
          setImportPath('')
          setMessage({ key: 'bindings.imported' })
        })
        if (!enabled) return null
        const visibleEntries = catalog?.entries.filter(entry =>
          entry.name.toLowerCase().includes(catalogQuery.trim().toLowerCase())) ?? []
        return h('section', { className: 'ptcPlusBindings', 'aria-label': t('bindings.title'), 'aria-busy': busy },
          h('div', { className: 'ptcPlusBindingsHead' },
            heading ? h('h3', { className: 'ptcPlusBindingsTitle' }, headingLabel ?? t('bindings.title')) : h('span'),
            h('div', { className: 'ptcPlusBindingsActions' },
              h(IconButton, {
                icon: IconRefreshOutline16, label: t('bindings.reload'), disabled: busy,
                onClick: reload,
              }),
              h(ActionButton, {
                type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', disabled: busy || editing,
                onClick: () => {
                  requestGeneration.current += 1
                  setDraft(blankBinding())
                  setOriginal(null)
                  setEditRevision(catalog?.revision ?? null)
                  setEditing(true)
                  setSourceOpen(true)
                  setMetadataOpen(true)
                  setDeclaration('')
                  setConsoleVersion(current => current + 1)
                },
              }, typeof IconPlusOutline16 === 'function' ? h(IconPlusOutline16, { size: 16 }) : null, t('bindings.new')))),
          catalog === null
            ? h('p', {
                className: `ptcPlusMessage${message === null ? '' : ' ptcPlusDanger'}`,
                role: message === null ? undefined : 'status',
              }, message === null ? t('bindings.loading') : t(message.key, message.params))
            : h('div', { className: 'ptcPlusBindingsGrid' },
                h('div', { className: 'ptcPlusBindingPane' },
                  h('label', { className: 'ptcPlusSearch' },
                    typeof IconSearchOutline16 === 'function' ? h(IconSearchOutline16, { size: 16 }) : null,
                    h('input', { value: catalogQuery, onChange: event => setCatalogQuery(event.target.value),
                      placeholder: t('bindings.search'), 'aria-label': t('bindings.search') })),
                  catalog.error === undefined
                    ? null
                    : h('p', { className: 'ptcPlusMessage ptcPlusDanger' }, catalog.error),
                  catalog.entries.length === 0
                    ? h('p', { className: 'ptcPlusMessage' }, t('bindings.empty'))
                    : h('ul', { className: 'ptcPlusBindingList' }, visibleEntries.map(entry => (
                        h('li', {
                          key: entry.id, className: 'ptcPlusBindingItem',
                          'data-selected': draft?.id === entry.id ? true : undefined,
                        },
                          h('button', {
                            type: 'button', className: 'ptcPlusBindingSelect', disabled: busy || editing,
                            onClick: () => load(entry.id),
                          },
                          h('span', { className: 'ptcPlusBindingName', title: entry.name }, entry.name),
                          h('span', { className: 'ptcPlusBindingMeta', title: entry.symbols.join(', ') }, entry.scope)),
                          h('button', {
                            type: 'button', className: 'ptcPlusBindingSwitch', role: 'switch',
                            disabled: busy || editing, 'aria-checked': entry.enabled,
                            'aria-label': `${entry.name}: ${t('bindings.enabled')}`,
                            title: t(entry.enabled ? 'bindings.disableAction' : 'bindings.enableAction'),
                            onClick: () => toggle(entry),
                          }, h('span', { 'aria-hidden': true })))
                      ))),
                  catalog.entries.length > 0 && visibleEntries.length === 0
                    ? h('p', { className: 'ptcPlusMessage' }, t('console.noMatches')) : null,
                  h('div', { className: 'ptcPlusBindingRun' },
                    h('input', {
                      className: 'ptcPlusInput', value: importPath, disabled: busy,
                      placeholder: t('bindings.importPath'), 'aria-label': t('bindings.importPath'),
                      onChange: event => setImportPath(event.target.value),
                    }),
                    h(ActionButton, {
                      type: 'button', className: 'ptcPlusButton',
                      disabled: busy || editing || importPath.trim() === '', onClick: importSource,
                    }, t('bindings.import')))),
                draft === null ? null : h('div', { className: 'ptcPlusBindingEditor' },
                  h('div', { className: 'ptcPlusEditorHead' },
                    h('strong', { className: 'ptcPlusEditorFile' }, draft.name || t('bindings.new')),
                    h('div', { className: 'ptcPlusBindingLifecycle' },
                      editing ? h(React.Fragment, null,
                        h(ActionButton, { disabled: busy, onClick: validate },
                          h(IconCheckOutline14, { size: 14 }), t('bindings.validate')),
                        h(ActionButton, { 'data-kind': 'primary', disabled: busy, onClick: save }, t('bindings.save')),
                        h(ActionButton, { disabled: busy, onClick: () => {
                          showEntry(original === null ? null : { entry: original, revision: editRevision }, { resetConsole: false })
                          setSourceOpen(false)
                          setMessage(null)
                        } }, t('bindings.cancel'))) : null,
                      catalog.entries.some(entry => entry.id === draft.id)
                        ? h(IconButton, {
                            icon: IconTrashOutline16, label: t('bindings.remove'), 'data-kind': 'danger',
                            disabled: busy || editing, onClick: () => remove(draft),
                          })
                        : null)),
                  h('details', { className: 'ptcPlusBindingSection ptcPlusBindingSourcePreview', open: true },
                    h('summary', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.declaration')),
                    declaration === '' ? h('p', { className: 'ptcPlusMessage' }, t('bindings.unvalidated'))
                      : typeof CodeBlock === 'function'
                        ? h(CodeBlock, { code: declaration, lang: 'typescript', className: 'ptcPlusCodeBlock',
                          copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
                        : h('pre', { className: 'ptcPlusDeclaration' }, declaration)),
                  h('section', { className: 'ptcPlusBindingSection ptcPlusModelPrompt' },
                    h('h4', { className: 'ptcPlusBindingSectionTitle' }, t('bindings.modelContext')),
                    h('div', { className: 'ptcPlusBindingFields' },
                      h('label', { className: 'ptcPlusBindingField ptcPlusPromptToggle', 'data-wide': true },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.includeDeclaration')),
                        h('input', { className: 'ptcPlusCheck', type: 'checkbox', checked: draft.modelContext.includeDeclaration, disabled: busy,
                          onChange: event => edit('modelContext', { ...draft.modelContext, includeDeclaration: event.target.checked }) })),
                      h('label', { className: 'ptcPlusBindingField', 'data-wide': true },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.instructions')),
                        h('textarea', { className: 'ptcPlusInput', rows: 3, maxLength: 4096,
                          value: draft.modelContext.instructions, disabled: busy,
                          onChange: event => edit('modelContext', { ...draft.modelContext, instructions: event.target.value }) })))),
                  h('div', { className: 'ptcPlusSourceSection' },
                    h('button', { type: 'button', className: 'ptcPlusSourceToggle',
                      'aria-expanded': sourceOpen, onClick: () => setSourceOpen(!sourceOpen) },
                      h(IconChevronDownOutline14, { size: 14, style: { transform: sourceOpen ? undefined : 'rotate(-90deg)' } }),
                      t('bindings.sourcePreview'),
                      h('span', { className: 'ptcPlusSourceFilename' }, draft.name ? `${draft.name}.ts` : '')),
                    h('div', { className: 'ptcPlusSourceActions' }, editing ? null
                      : h(ActionButton, { disabled: busy, onClick: () => { setEditing(true); setSourceOpen(true) } },
                        typeof IconEditOutline16 === 'function' ? h(IconEditOutline16, { size: 14 }) : null, t('bindings.edit'))),
                    h('div', { className: 'ptcPlusSourceBody', hidden: !sourceOpen },
                      editing ? h(TypeScriptEditor, { documentId: draft.id, value: draft.source, disabled: busy,
                        label: t('bindings.source'), onChange: value => edit('source', value) })
                        : sourceOpen && typeof CodeBlock === 'function'
                          ? h(CodeBlock, { code: draft.source, lang: 'typescript', className: 'ptcPlusSourceCode',
                            copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
                          : sourceOpen ? h('pre', { className: 'ptcPlusSourceCode' }, draft.source) : null)),
                  h('div', { className: 'ptcPlusWorkbenchFeedback', role: 'status' },
                    busy ? t('bindings.working') : message === null ? '' : t(message.key, message.params)),
                  h(BindingConsole, { key: draft.id, entryId: draft.id, source: draft.source,
                    resetVersion: consoleVersion, callUserBindings, t }),
                  h('details', { className: 'ptcPlusBindingSection ptcPlusEntrySettings', open: metadataOpen,
                    onToggle: event => setMetadataOpen(event.currentTarget.open) },
                    h('summary', { className: 'ptcPlusBindingSectionTitle' }, t('bindings.entry')),
                    h('div', { className: 'ptcPlusBindingFields' },
                      h('label', { className: 'ptcPlusBindingField' },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.id')),
                        h('input', {
                          className: 'ptcPlusInput', value: draft.id, disabled: busy || !editing,
                          onChange: event => edit('id', event.target.value),
                        })),
                      h('label', { className: 'ptcPlusBindingField' },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.name')),
                        h('input', {
                          className: 'ptcPlusInput', value: draft.name, disabled: busy || !editing,
                          onChange: event => edit('name', event.target.value),
                        })),
                      h('label', { className: 'ptcPlusBindingField' },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.scope')),
                        h('select', {
                          className: 'ptcPlusSelect', value: draft.scope, disabled: busy || !editing,
                          onChange: event => edit('scope', event.target.value),
                        }, h('option', { value: 'namespace' }, 'namespace'), h('option', { value: 'top-level' }, 'top-level'))),
                      h('label', { className: 'ptcPlusBindingField' },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.symbols')),
                        h('input', {
                          className: 'ptcPlusInput', value: draft.symbolsText, disabled: busy || !editing,
                          placeholder: t('bindings.symbolsPlaceholder'),
                          onChange: event => edit('symbolsText', event.target.value),
                        })),
                      h('label', { className: 'ptcPlusBindingField', 'data-wide': true },
                        h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.purpose')),
                        h('input', {
                          className: 'ptcPlusInput', value: draft.purpose, disabled: busy || !editing,
                          onChange: event => edit('purpose', event.target.value),
                        }))))),
                message === null || draft !== null
                  ? null
                  : h('p', { className: 'ptcPlusMessage', role: 'status' }, t(message.key, message.params))))
      }

      function ReplComposer() { return null }

      function ReplBindingInspector({ entry, preview, t }) {
        const readable = preview?.status === 'readable'
        return h('aside', { className: 'ptcPlusBindingInspector', 'aria-label': entry.name },
          h('header', { className: 'ptcPlusInspectorHead' },
            h('strong', null, entry.name),
            h('span', null, t('memory.location', entry.definition))),
          h('div', { className: 'ptcPlusObservationLabel' }, t('console.definition')),
          typeof CodeBlock === 'function'
            ? h(CodeBlock, { code: entry.definition.source, lang: 'typescript', className: 'ptcPlusObservationCode',
                copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
            : h('pre', { className: 'ptcPlusObservationCode' }, entry.definition.source),
          h('div', { className: 'ptcPlusObservationLabel' }, t('console.value'),
            preview?.truncated ? h('span', { className: 'ptcPlusObservationState' }, t('console.bounded')) : null),
          readable ? h('pre', { className: 'ptcPlusObservationPreview' }, preview.text)
            : h('p', { className: 'ptcPlusObservationUnavailable' }, t('console.unreadable')))
      }

      function ReplSessionBindings({ memory, t }) {
        const [query, setQuery] = React.useState('')
        const [kind, setKind] = React.useState('all')
        const [selectedName, setSelectedName] = React.useState(null)
        const entries = memory.entries.filter(entry => (kind === 'all' || entry.kind === kind)
          && entry.name.toLowerCase().includes(query.trim().toLowerCase()))
        const selected = entries.find(entry => entry.name === selectedName) ?? entries[0]
        const observation = memory.observation
        const previews = new Map(observation?.entries.map(entry => [entry.name, entry]) ?? [])
        return h('section', { className: 'ptcPlusConsoleSection ptcPlusSessionBindings', 'aria-label': t('console.session') },
          h('div', { className: 'ptcPlusObservationHead' },
            h('div', { className: 'ptcPlusObservationTitle' },
              h('h2', null, t('console.session')),
              memory.available ? h('span', { className: 'ptcPlusObservationCount', title: t('memory.count', { count: memory.total }) },
                query.trim() || kind !== 'all' ? `${entries.length} / ${memory.total}` : memory.total) : null),
            h('span', { className: 'ptcPlusObservationTime' }, observation === undefined
              ? t('console.unobserved') : t('console.observed', { time: new Date(observation.at).toLocaleString() }))),
          memory.entries.length === 0 ? h('div', { className: 'ptcPlusSessionEmpty' },
            t(memory.available ? 'memory.empty' : 'memory.unavailable'))
            : h('div', { className: 'ptcPlusObservationGrid', 'data-empty': selected === undefined },
            h('div', { className: 'ptcPlusObservationCatalog' },
              h('div', { className: 'ptcPlusObservationFilters' },
                h('label', { className: 'ptcPlusSearch' },
                  typeof IconSearchOutline16 === 'function' ? h(IconSearchOutline16, { size: 16 }) : null,
                  h('input', { value: query, onChange: event => setQuery(event.target.value),
                    placeholder: t('console.search'), 'aria-label': t('console.search') })),
                h('select', { className: 'ptcPlusSelect', value: kind, onChange: event => setKind(event.target.value),
                  'aria-label': t('console.kind') },
                  ['all', 'variable', 'function', 'class', 'import'].map(value => h('option', { key: value, value },
                    t(value === 'all' ? 'console.allKinds' : `memory.kind.${value}`))))),
              h('div', { className: 'ptcPlusObservations' },
                h('table', { className: 'ptcPlusObservationTable', 'aria-label': t('console.session') },
                  h('thead', null, h('tr', null,
                    h('th', { scope: 'col' }, t('console.name')),
                    h('th', { scope: 'col' }, t('console.kind')),
                    h('th', { scope: 'col' }, t('console.value')))),
                  h('tbody', null, entries.map(entry => {
                    const preview = previews.get(entry.name)
                    return h('tr', { key: entry.name, 'data-selected': entry === selected,
                      onClick: () => setSelectedName(entry.name) },
                      h('td', null, h('button', { type: 'button', className: 'ptcPlusObservationSelect',
                        'aria-current': entry === selected ? 'true' : undefined, title: entry.name }, entry.name)),
                      h('td', { className: 'ptcPlusObservationKind' }, t(`memory.kind.${entry.kind}`)),
                      h('td', null, h('span', { className: 'ptcPlusObservationValue' },
                        preview?.status === 'readable' ? h('code', null, preview.text)
                          : h('span', { className: 'ptcPlusObservationState' }, t('console.unreadable')),
                        preview?.truncated ? h('span', { className: 'ptcPlusObservationState' }, t('console.bounded')) : null)))
                  }))),
                entries.length === 0 ? h('p', { className: 'ptcPlusMessage ptcPlusObservationEmpty' },
                  t(!memory.available ? 'memory.unavailable' : memory.entries.length === 0 ? 'memory.empty' : 'console.noMatches')) : null)),
            selected ? h(ReplBindingInspector, { entry: selected, preview: previews.get(selected.name), t }) : null),
          memory.omitted > 0 ? h('p', { className: 'ptcPlusMessage' }, t('memory.more', { count: memory.omitted })) : null)
      }

      function ReplConsole({ t, sessionId, useProjection, useSessions, usePtcSettings, callUserBindings, hideComposer, observeRepl }) {
        const preset = useSessionPreset({ sessionId, useProjection, useSessions })
        const projected = useProjection('ptcPlusRepl')
        const settings = usePtcSettings(snapshot => snapshot)
        const globalEnabled = settings.value?.userBindingsEnabled === true
        const eligible = settings.status === 'ready' && settings.value?.enabled === true
          && settings.value?.replViewEnabled !== false && sessionUsesPtcPreset(preset)
        const observationRegion = React.useRef(null)
        React.useEffect(() => eligible ? hideComposer(sessionId) : undefined, [eligible, hideComposer, sessionId])
        React.useEffect(() => eligible ? observeRepl(sessionId, observationRegion.current) : undefined, [eligible, observeRepl, sessionId])
        if (!eligible) return null
        let memory
        try { memory = normalizeReplMemorySnapshot(projected) } catch { memory = unavailableReplMemorySnapshot() }
        return h('div', { className: 'ptcPlusConsole', 'data-conversation-composer-overlay': '' },
          h('div', { className: 'ptcPlusConsoleSection', ref: observationRegion }, h(ReplSessionBindings, { key: sessionId, memory, t })),
          globalEnabled ? h('div', { className: 'ptcPlusConsoleSection ptcPlusBindingsSurface' },
            h(UserBindingsWorkbench, { enabled: true, t, callUserBindings, headingLabel: t('console.global') })) : null)
      }

      function BindingsDialog({ t, callUserBindings, onClose }) {
        const content = React.useRef(null)
        React.useEffect(() => {
          const previous = document.activeElement
          content.current.querySelector('button')?.focus()
          return () => { if (previous?.isConnected) previous.focus() }
        }, [])
        const trapFocus = event => {
          if (event.key !== 'Tab') return
          const controls = [...content.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[contenteditable=true],summary')]
            .filter(element => element.getClientRects().length > 0)
          const first = controls[0]
          const last = controls.at(-1)
          if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first)?.focus()
          }
        }
        return h(Modal, { open: true, onClose, title: t('bindings.title'), headless: true, className: 'ptcPlusBindingsModal' },
          h('div', { className: 'ptcPlusBindingsDialog', ref: content, onKeyDown: trapFocus },
            h('div', { className: 'ptcPlusBindingsDialogHead' },
              h('h2', null, t('bindings.title')),
              h('button', { type: 'button', className: 'ptcPlusDialogClose', onClick: onClose, 'aria-label': t('bindings.close'), title: t('bindings.close') }, h(IconCloseOutline16, { size: 16 }))),
            h('div', { className: 'ptcPlusBindingsSurface' }, h(UserBindingsWorkbench, { enabled: true, t, callUserBindings, heading: false }))))
      }

      function PTCPlusSettingsCard({ t, usePtcSettings, updateSetting, callUserBindings }) {
        const [open, setOpen] = React.useState(false)
        const [bindingsOpen, setBindingsOpen] = React.useState(false)
        const [status, setStatus] = React.useState(null)
        const [pending, setPending] = React.useState(() => new Set())
        const writeTail = React.useRef(Promise.resolve())
        const snapshot = usePtcSettings(snapshot => snapshot)
        const value = snapshot.status === 'ready' ? (snapshot.value ?? {}) : {}
        const enabled = value.enabled === true
        const globalEnabled = enabled && value.userBindingsEnabled === true
        React.useEffect(() => { if (!globalEnabled) setBindingsOpen(false) }, [globalEnabled])
        const unavailable = snapshot.status !== 'ready' || snapshot.writable !== true
        const persist = (field, nextValue) => {
          if (unavailable || pending.has(field.key)) return
          const operation = writeTail.current.then(async () => {
            setPending(current => new Set(current).add(field.key))
            setStatus(null)
            try {
              const key = await updateSetting(field.key, nextValue)
              if (key !== null) setStatus({ key })
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
        const settingGroups = CONFIG_GROUPS.map(group => h('section', {
          key: group.key,
          className: 'ptcPlusGroup',
          'aria-labelledby': `ptc-plus-settings-group-${group.key}`,
        },
        h('h3', {
          id: `ptc-plus-settings-group-${group.key}`,
          className: 'ptcPlusGroupTitle',
        }, t(`group.${group.key}`)),
        ...group.fields.map(key => {
          const field = CONFIG_FIELDS.find(candidate => candidate.key === key)
          if (field === undefined) return null
          return h('div', { key: field.key, className: 'ptcPlusRow' },
            h('div', { className: 'ptcPlusMain' },
              h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
              field.description === '' ? null : h('div', { className: 'ptcPlusDetail' }, t(`${field.key}.description`))),
            fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`)))
        })))
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
          h('div', { id: 'ptc-plus-settings-body', className: 'ptcPlusBody', 'data-open': open, hidden: !open },
            h('div', { className: 'ptcPlusBodyInner' }, h('div', { className: 'ptcPlusFields' },
              snapshot.status === 'loading'
                ? h('p', { className: 'ptcPlusMessage' }, t('state.syncing'))
                : snapshot.status === 'unavailable'
                  ? h('p', { className: 'ptcPlusMessage' }, t('state.unavailable'))
                  : [
                    ...settingGroups,
                    globalEnabled
                      ? h(ActionButton, { key: 'user-bindings', type: 'button', className: 'ptcPlusButton', onClick: () => setBindingsOpen(true) }, t('bindings.manage'))
                      : null,
                    h('div', { key: 'footer', className: 'ptcPlusFooter' },
                      h('span', { className: 'ptcPlusMessage', role: 'status' }, status === null
                        ? t(snapshot.writable ? 'footer.live' : 'footer.readOnly')
                        : t(status.key, status.params))),
                  ]))),
          globalEnabled && bindingsOpen ? h(BindingsDialog, { t, callUserBindings, onClose: () => setBindingsOpen(false) }) : null,
        )
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE_NS,
        inject: () => ({ ...settingsProps(), updateSetting }),
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

      ctx.inject(['sessions'], (viewScope) => {
        const hideComposer = sessionId => viewScope.effect(() => viewScope.slots.inject(
          'conversation.composer', () => viewScope.slots.register({
            name: 'conversation.composer', priority: 100,
            select: owner => isIdleSessionComposer(owner, sessionId) ? true : null,
          }, ReplComposer),
        ))
        viewScope.slots.inject('conversation.view', () => viewScope.effect(() => {
          let preset
          let disposeView
          const sync = () => {
            const settings = preferenceScope.getSnapshot()
            const eligible = settings.status === 'ready' && settings.value?.enabled === true
              && settings.value?.replViewEnabled !== false
              && sessionUsesPtcPreset(preset)
            if (eligible === (disposeView !== undefined)) return
            disposeView?.()
            disposeView = eligible ? viewScope.slots.register({
              name: 'conversation.view', id: 'ptc-plus-repl', label: 'REPL', order: 20,
              locale: LOCALE_NS, inject: () => ({ ...settingsProps(), hideComposer, observeRepl }),
            }, props => typeof props.useProjection === 'function' ? h(ReplConsole, props) : null) : undefined
          }
          const unsubscribePreset = watchCurrentSessionPreset(viewScope.sessions, value => {
            preset = value
            sync()
          })
          const unsubscribeSettings = preferenceScope.subscribe(sync)
          return () => {
            unsubscribePreset()
            unsubscribeSettings()
            disposeView?.()
          }
        }))
      })

      function BindingAuthorButton({
        t, useInput, inputActions, usePtcSettings, useBindingCommand,
      }) {
        const input = useInput(snapshot => snapshot)
        const available = useBindingCommand(snapshot => snapshot)
        const settings = usePtcSettings(snapshot => snapshot)
        const anchorRef = React.useRef(null)
        const toastSequence = React.useRef(0)
        const [toast, setToast] = React.useState(null)
        React.useEffect(() => {
          if (toast === null || typeof Toast === 'function') return undefined
          const timer = setTimeout(() => setToast(null), 2_500)
          return () => clearTimeout(timer)
        }, [toast])
        const globalEnabled = settings.status === 'ready'
          && settings.value?.enabled === true
          && settings.value?.userBindingsEnabled === true
          && settings.value?.bindingAuthorButtonVisible !== false
        if (!globalEnabled || !available || typeof inputActions?.setDraft !== 'function') return null
        const label = t('bindings.authorOpen')
        const openAuthoring = () => {
          if (typeof input?.draft === 'string' && input.draft.trim() !== '') {
            toastSequence.current += 1
            setToast({ sequence: toastSequence.current, text: t('bindings.composerBusy') })
            return
          }
          inputActions.setDraft('/binding new ')
        }
        const starButton = h('button', {
          type: 'button', className: 'ptcPlusAuthorButton', 'aria-label': label,
          onMouseDown: event => event.preventDefault(), onClick: openAuthoring,
        }, typeof IconSparkle16 === 'function'
          ? h(IconSparkle16, { size: 16, 'aria-hidden': true })
          : h('span', { className: 'ptcPlusAuthorButtonLabel', 'aria-hidden': true }, t('bindings.authorNew')))
        return h('span', {
          className: 'ptcPlusAuthorButtonShell',
          'data-text': typeof IconSparkle16 === 'function' ? undefined : true,
          ref: anchorRef,
        },
          typeof Tooltip === 'function'
            ? h(Tooltip, { label, side: 'top', delayMs: 400 }, starButton)
            : starButton,
          toast === null ? null : typeof Toast === 'function'
            ? h(Toast, {
              key: toast.sequence,
              text: toast.text,
              anchor: anchorRef.current,
              onDone: () => setToast(null),
            })
            : h('span', {
              key: toast.sequence, className: 'ptcPlusComposerNotice', role: 'status',
            }, toast.text))
      }

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

      function ReplMemoryCard({
        memory,
        globalEnabled,
        globalBindings,
        authoringDraft,
        authoringPhase,
        loadGlobalBinding,
        prefillAuthoring,
        saveAuthoringDraft,
        discardAuthoringDraft,
        authoringMessage,
        t,
        id,
        titleId,
        popoverRef,
        onEnter,
        onLeave,
      }) {
        const [expandedBinding, setExpandedBinding] = React.useState(null)
        const [tab, setTab] = React.useState('session')
        const [globalSource, setGlobalSource] = React.useState(null)
        const activeTab = globalEnabled ? tab : 'session'
        const summary = activeTab === 'session'
          ? memory.available ? t('memory.count', { count: memory.total }) : ''
          : globalBindings === undefined ? '' : t('memory.globalCount', { count: globalBindings.entries.length })
        const inspectGlobal = entry => {
          if (globalSource?.id === entry.id) {
            setGlobalSource(null)
            return
          }
          setGlobalSource({ id: entry.id, source: '' })
          loadGlobalBinding(entry.id).then(
            loaded => setGlobalSource(current => current?.id === entry.id
              ? { id: entry.id, source: loaded.entry.source }
              : current),
            () => setGlobalSource(current => current?.id === entry.id
              ? { id: entry.id, error: true, source: '' }
              : current),
          )
        }
        return h('div', {
          className: 'ptcPlusReplPopover', id, ref: popoverRef, popover: 'auto',
          role: 'dialog', 'aria-labelledby': titleId,
          onPointerEnter: onEnter, onPointerLeave: onLeave,
        },
        h('div', { className: 'ptcPlusReplCard' },
          h('div', { className: 'ptcPlusReplHead' },
            h('span', { className: 'ptcPlusReplStatusDot', 'aria-hidden': true }),
            h('span', { className: 'ptcPlusReplTitle', id: titleId }, t('memory.title')),
            h('span', {
              className: 'ptcPlusReplSummary',
              'aria-hidden': summary === '' ? true : undefined,
            }, summary)),
          globalEnabled
            ? h('div', { className: 'ptcPlusReplTabs', role: 'tablist' },
                h('button', {
                  type: 'button', role: 'tab', className: 'ptcPlusReplTab',
                  'aria-selected': activeTab === 'session', onClick: () => setTab('session'),
                }, t('memory.sessionTab')),
                h('button', {
                  type: 'button', role: 'tab', className: 'ptcPlusReplTab',
                  'aria-selected': activeTab === 'global', onClick: () => setTab('global'),
                }, t('memory.globalTab')))
            : null,
          activeTab === 'global'
            ? h('div', { className: 'ptcPlusGlobalPane' },
                globalBindings === undefined
                  ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalUnavailable'))
                  : globalBindings.entries.length === 0
                    ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalEmpty'))
                    : h('ul', { className: 'ptcPlusGlobalList' }, globalBindings.entries.map(entry => (
                    h('li', { key: entry.id, className: 'ptcPlusGlobalItem' },
                      h('button', {
                        type: 'button', className: 'ptcPlusBindingSelect',
                        'aria-expanded': globalSource?.id === entry.id,
                        onClick: () => inspectGlobal(entry),
                      },
                      h('span', { className: 'ptcPlusBindingName', title: entry.name }, entry.name),
                      h('span', { className: 'ptcPlusBindingMeta', title: entry.symbols.join(', ') }, `${entry.scope} - ${entry.symbols.join(', ')}`),
                      h('span', { className: 'ptcPlusBindingState', 'data-enabled': entry.enabled },
                        t(entry.enabled ? 'bindings.enabled' : 'bindings.disabledEntry'))),
                      h(ActionButton, {
                        type: 'button', className: 'ptcPlusButton',
                        onClick: () => prefillAuthoring(`/binding edit ${entry.id} `),
                      }, typeof IconSparkle16 === 'function'
                        ? h(IconSparkle16, { size: 14, 'aria-hidden': true })
                        : null, t('bindings.authorEdit')),
                      globalSource?.id !== entry.id
                        ? null
                        : globalSource.error === true
                          ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalUnavailable'))
                          : h('pre', { className: 'ptcPlusGlobalSource' }, globalSource.source))
                    )))
              )
            : !memory.available
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
          tab !== 'session' || memory.omitted === 0 ? null
            : h('span', { className: 'ptcPlusReplMore' }, t('memory.more', { count: memory.omitted }))))
      }

      function BindingCommandCard({ node, t, useProjection, callUserBindings }) {
        const projectionValue = useProjection?.('ptcPlusBindingDraft')
        let projection
        try {
          projection = normalizeUserBindingDraftView(projectionValue)
        } catch {
          projection = undefined
        }
        const matches = projection?.commandId === node.commandId
        const capability = matches ? projection.capability : null
        const phase = matches ? projection.phase : node.outcome === null ? 'pending' : 'idle'
        const [catalog, setCatalog] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [review, setReview] = React.useState(null)
        const [message, setMessage] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [loaded, setLoaded] = React.useState(false)
        React.useEffect(() => {
          let active = true
          setCatalog(null)
          setDraft(null)
          setLoaded(false)
          if (phase !== 'ready' || capability === null) return () => { active = false }
          setMessage(null)
          Promise.all([
            callUserBindings('list'),
            callUserBindings('draft', { capability }),
            callUserBindings('draft-review', { capability }),
          ]).then(([nextCatalog, nextDraft, nextReview]) => {
            if (!active) return
            setCatalog(nextCatalog)
            setDraft(nextDraft)
            setReview(nextReview)
            setLoaded(true)
          }).catch(error => {
            if (!active) return
            setLoaded(true)
            setMessage(error instanceof Error ? error.message : String(error))
          })
          return () => { active = false }
        }, [capability, phase])
        React.useEffect(() => {
          if (draft === null || busy || phase !== 'ready') return undefined
          let active = true
          let pending = false
          const timer = setInterval(async () => {
            if (pending) return
            pending = true
            try {
              const [current, nextReview] = await Promise.all([
                callUserBindings('draft', { capability }),
                callUserBindings('draft-review', { capability }),
              ])
              if (active) { setDraft(current); setReview(nextReview) }
            } catch {
              // A failed read proves neither revocation nor persistence.
            } finally {
              pending = false
            }
          }, 1500)
          return () => { active = false; clearInterval(timer) }
        }, [capability, phase, draft, busy])
        const refresh = async () => {
          const [nextCatalog, nextDraft, nextReview] = await Promise.all([
            callUserBindings('list'), callUserBindings('draft', { capability }),
            callUserBindings('draft-review', { capability }),
          ])
          setCatalog(nextCatalog)
          setDraft(nextDraft)
          setReview(nextReview)
        }
        const save = async (activate = false) => {
          if (busy || draft === null || catalog === null || capability === null) return
          setBusy(true)
          setMessage(null)
          try {
            await callUserBindings('save-draft', {
              capability, version: draft.version, expectedRevision: catalog.revision,
              activate,
            })
            setDraft(null)
            await refresh()
          } catch (error) {
            await refresh().catch(() => {})
            setMessage(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        }
        const discard = async () => {
          if (busy || draft === null || capability === null) return
          setBusy(true)
          setMessage(null)
          try {
            await callUserBindings('discard-draft', { capability, version: draft.version })
            setDraft(null)
            await refresh()
          } catch (error) {
            await refresh().catch(() => {})
            setMessage(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        }
        const outcome = node.outcome
        const outcomeText = outcome?.kind === 'error'
          ? outcome.text ?? t('bindings.commandFailed')
          : undefined
        const historical = projection?.history?.find(record => record.commandId === node.commandId)
        const currentReview = historical?.action !== null && historical?.action !== undefined
          ? historical : review ?? historical
        const candidate = currentReview?.candidate ?? draft
        const action = currentReview?.action
        const actionKey = action?.state === 'discarded' ? 'bindings.commandDiscarded'
          : action?.state === 'saved'
            ? action.enabled ? 'bindings.commandSavedEnabled' : 'bindings.commandSaved' : null
        const failed = outcome?.kind === 'error' || phase === 'failed'
        const displayPhase = action?.state ?? (failed ? 'failed' : phase === 'ready' && loaded && draft === null ? 'idle' : phase)
        return h('section', {
          className: 'ptcPlusBindingCommand', 'data-phase': displayPhase,
          'aria-label': t('bindings.commandTitle'),
        },
          h('div', { className: 'ptcPlusBindingCommandHeader' },
            h('strong', { className: 'ptcPlusBindingCommandTitle' }, t('bindings.commandTitle')),
            h('span', { className: 'ptcPlusBindingCommandState' },
              h('span', { className: 'ptcPlusBindingCommandStateDot', 'aria-hidden': true }),
              actionKey !== null ? t(actionKey) : displayPhase === 'pending'
                ? t('bindings.commandPending')
                : displayPhase === 'ready'
                  ? t('bindings.commandReady')
                  : displayPhase === 'failed' ? t('bindings.commandFailed')
                    : t('bindings.commandUnavailable'))),
          h('pre', { className: 'ptcPlusBindingCommandRequirement' }, `/binding${node.args ?? ''}`),
          outcomeText === undefined ? null : h('p', {
            className: `ptcPlusMessage${outcome?.kind === 'error' ? ' ptcPlusDanger' : ''}`,
          }, outcomeText),
          phase === 'ready' && draft === null && message === null && !loaded
            ? h('span', { className: 'ptcPlusMessage' }, t('bindings.commandPending'))
            : null,
          candidate === null || candidate === undefined ? null : h('div', { className: 'ptcPlusAuthoringDraft' },
            h('strong', null, candidate.entry.name),
            h('span', { className: 'ptcPlusBindingMeta' }, `${candidate.entry.scope} - ${candidate.entry.symbols.join(', ')}`),
            h('details', { className: 'ptcPlusBindingSourceDetails', open: actionKey === null ? true : undefined },
            h('summary', null, t('tool.source')),
            typeof CodeBlock === 'function'
              ? h(CodeBlock, {
                code: candidate.entry.source, lang: 'typescript', className: 'ptcPlusBindingCommandCode',
                copyLabel: t('tool.copy'), copiedLabel: t('tool.copied'),
              })
              : h('pre', { className: 'ptcPlusBindingCommandSource' }, candidate.entry.source)),
            h('details', { className: 'ptcPlusBindingPromptDetails' },
              h('summary', null, t('bindings.modelContext')),
              h('label', { className: 'ptcPlusBindingFieldLabel' },
                h('input', { type: 'checkbox', className: 'ptcPlusCheck', disabled: true,
                  checked: bindingModelPreferences(candidate.entry.modelContext).includeDeclaration }),
                t('bindings.includeDeclaration')),
              h('span', { className: 'ptcPlusBindingFieldLabel' }, t('bindings.instructions')),
              h('pre', { className: 'ptcPlusBindingCommandRequirement' },
                bindingModelPreferences(candidate.entry.modelContext).instructions || t('bindings.noInstructions'))),
            draft === null || actionKey !== null ? null : h('div', { className: 'ptcPlusBindingCommandActions' },
              h(ActionButton, { type: 'button', className: 'ptcPlusButton', disabled: busy, onClick: () => save(false) }, t('bindings.draftSave')),
              h(ActionButton, { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', disabled: busy, onClick: () => save(true) }, t('bindings.draftSaveEnable')),
              h(ActionButton, { type: 'button', className: 'ptcPlusButton', 'data-kind': 'ghost', disabled: busy, onClick: discard }, t('bindings.draftDiscard')))),
          message === null ? null : h('p', { className: 'ptcPlusMessage', role: 'status' }, message))
      }

      function PTCPlusSessionIndicator({
        sessionId, t, useProjection, useSessions, useInput, inputActions, usePtcSettings, callUserBindings,
      }) {
        const preset = useSessionPreset({ sessionId, useProjection, useSessions })
        const projectionMemory = useProjection('ptcPlusRepl')
        const projectionDraftCapability = useProjection('ptcPlusBindingDraft')
        const settings = usePtcSettings(snapshot => snapshot)
        let input
        try {
          input = typeof useInput === 'function' ? useInput(snapshot => snapshot) : undefined
        } catch {
          input = undefined
        }
        const resolvedSessionId = sessionId
        let draftProjection = { phase: 'idle', capability: null, commandId: null }
        try {
          draftProjection = normalizeUserBindingDraftView(
            projectionDraftCapability ?? { phase: 'idle', capability: null, commandId: null },
          )
        } catch {}
        const draftCapability = draftProjection.capability
        const globalEnabled = settings.status === 'ready'
          && settings.value?.enabled === true
          && settings.value?.userBindingsEnabled === true
        const refreshIdentity = JSON.stringify([
          resolvedSessionId === undefined ? null : String(resolvedSessionId),
          draftProjection.phase,
          draftCapability,
          globalEnabled,
        ])
        const refreshControl = React.useRef(undefined)
        if (refreshControl.current?.identity !== refreshIdentity) {
          refreshControl.current = {
            identity: refreshIdentity,
            sequence: 0,
            mutating: false,
            draftConsumed: false,
          }
        }
        const [globalBindingsState, setGlobalBindingsState] = React.useState(undefined)
        const [authoringDraftState, setAuthoringDraftState] = React.useState(undefined)
        const [authoringMessage, setAuthoringMessage] = React.useState(null)
        const globalBindings = globalBindingsState?.identity === refreshIdentity
          ? globalBindingsState.value
          : undefined
        const authoringDraft = authoringDraftState?.identity === refreshIdentity
          ? authoringDraftState.value
          : null
        const refreshGlobalBindings = React.useCallback(() => {
          const control = refreshControl.current
          if (control.identity !== refreshIdentity || control.mutating) return Promise.resolve()
          const sequence = ++control.sequence
          if (!globalEnabled) {
            setGlobalBindingsState({ identity: refreshIdentity, value: undefined })
            setAuthoringDraftState({ identity: refreshIdentity, value: null })
            return Promise.resolve()
          }
          const effectiveDraftCapability = control.draftConsumed ? null : draftCapability
          return Promise.all([
            callUserBindings('list'),
            effectiveDraftCapability === null
              ? Promise.resolve(null)
              : callUserBindings('draft', { capability: effectiveDraftCapability }),
          ]).then(([bindings, draft]) => {
            if (refreshControl.current !== control || control.sequence !== sequence
              || control.mutating) return
            setGlobalBindingsState({ identity: refreshIdentity, value: bindings })
            setAuthoringDraftState({ identity: refreshIdentity, value: draft })
          }).catch(() => {
            if (refreshControl.current !== control || control.sequence !== sequence
              || control.mutating) return
            setGlobalBindingsState({ identity: refreshIdentity, value: undefined })
            setAuthoringDraftState({ identity: refreshIdentity, value: null })
          })
        }, [draftCapability, globalEnabled, refreshIdentity])
        React.useEffect(() => {
          void refreshGlobalBindings()
        }, [refreshGlobalBindings])
        const triggerRef = React.useRef(null)
        const popoverRef = React.useRef(null)
        const closeTimer = React.useRef(undefined)
        const [expanded, setExpanded] = React.useState(false)
        React.useEffect(() => {
          if (!expanded || !globalEnabled) return undefined
          const timer = setInterval(() => { void refreshGlobalBindings() }, 1_500)
          return () => clearInterval(timer)
        }, [expanded, globalEnabled, refreshGlobalBindings])
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
          void refreshGlobalBindings()
        }, [refreshGlobalBindings])
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
        const prefillAuthoring = React.useCallback((value) => {
          if (typeof inputActions?.setDraft !== 'function') return
          if (typeof input?.draft === 'string' && input.draft.trim() !== '') {
            setAuthoringMessage('bindings.composerBusy')
            return
          }
          inputActions.setDraft(value)
          setAuthoringMessage(null)
          hidePopover()
        }, [hidePopover, input?.draft, inputActions])
        const saveAuthoringDraft = React.useCallback(() => {
          if (authoringDraft === null || globalBindings === undefined) return
          const control = refreshControl.current
          if (control.identity !== refreshIdentity || control.mutating) return
          control.mutating = true
          control.sequence += 1
          void callUserBindings('save-draft', {
            capability: draftCapability,
            version: authoringDraft.version,
            expectedRevision: globalBindings.revision,
          }).then(next => {
            if (refreshControl.current !== control) return
            control.draftConsumed = true
            setGlobalBindingsState({ identity: refreshIdentity, value: next })
            setAuthoringDraftState({ identity: refreshIdentity, value: null })
            setAuthoringMessage('bindings.draftSaved')
          }).catch(() => {
            if (refreshControl.current === control) setAuthoringMessage('memory.globalUnavailable')
          }).finally(() => {
            if (refreshControl.current === control) control.mutating = false
          })
        }, [authoringDraft, draftCapability, globalBindings, refreshIdentity])
        const discardAuthoringDraft = React.useCallback(() => {
          if (authoringDraft === null) return
          const control = refreshControl.current
          if (control.identity !== refreshIdentity || control.mutating) return
          control.mutating = true
          control.sequence += 1
          void callUserBindings('discard-draft', {
            capability: draftCapability, version: authoringDraft.version,
          }).then(() => {
            if (refreshControl.current !== control) return
            control.draftConsumed = true
            setAuthoringDraftState({ identity: refreshIdentity, value: null })
            setAuthoringMessage(null)
          }).catch(() => {
            if (refreshControl.current === control) setAuthoringMessage('memory.globalUnavailable')
          }).finally(() => {
            if (refreshControl.current === control) control.mutating = false
          })
        }, [authoringDraft, draftCapability, refreshIdentity])
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
        if (!sessionUsesPtcPreset(preset)
          || settings.status !== 'ready' || settings.value?.enabled !== true) return null
        let memory
        try {
          memory = normalizeReplMemorySnapshot(projectionMemory)
        } catch {
          memory = unavailableReplMemorySnapshot()
        }
        const popoverId = `ptc-plus-repl-${String(resolvedSessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
        const titleId = `${popoverId}-title`
        return h('span', { className: 'ptcPlusActiveShell' },
          h('button', {
            type: 'button', className: 'ptcPlusActive', ref: triggerRef,
            title: t('indicator.title'),
            'aria-label': t('indicator.title'), 'aria-controls': popoverId,
            'aria-expanded': expanded, 'aria-haspopup': 'dialog',
            onPointerEnter: showPopover, onPointerLeave: scheduleHide,
            onFocus: showPopover, onBlur: scheduleHide, onClick: showPopover,
            onKeyDown: event => { if (event.key === 'Escape') hidePopover() },
          }, h('span', { className: 'ptcPlusActiveLabel' }, 'PTC Plus')),
          h(ReplMemoryCard, {
            memory,
            globalEnabled,
            globalBindings,
            authoringDraft,
            authoringPhase: draftProjection.phase,
            loadGlobalBinding: id => callUserBindings('load', { id }),
            prefillAuthoring,
            saveAuthoringDraft,
            discardAuthoringDraft,
            authoringMessage,
            t, id: popoverId, titleId, popoverRef,
            onEnter: showPopover, onLeave: scheduleHide,
          }))
      }
      ctx.slots.inject('conversation.session.header.actions', () => registerEnabled(ctx, false, () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'ptc-plus-active', order: -9, locale: LOCALE_NS,
        inject: settingsProps,
      }, props => typeof props.useProjection === 'function' ? h(PTCPlusSessionIndicator, props) : null)))
      ctx.slots.inject('conversation.chat.commandview', () => registerEnabled(ctx, true, () => ctx.slots.register({
        name: 'conversation.chat.commandview', key: 'binding', locale: LOCALE_NS,
        inject: settingsProps,
      }, props => h(BindingCommandCard, { ...props, key: props.node.commandId }))))
      ctx.inject(['remote', 'remote.commands'], (commandScope) => {
        const availability = createBindingCommandAvailability(commandScope)
        commandScope.slots.inject('conversation.input.left', () => registerEnabled(commandScope, true, () => commandScope.slots.register({
          name: 'conversation.input.left', id: 'ptc-plus-binding-author', order: 20, locale: LOCALE_NS,
          inject: sessionId => ({
            hooks: { ptcSettings: preferenceScope, bindingCommand: availability.source(sessionId) },
          }),
        }, props => typeof props.useInput === 'function' && typeof props.inputActions?.setDraft === 'function'
          ? h(BindingAuthorButton, props) : null)))
      })
    }

    module.exports = {
      apply,
      inject: ['settingsScope', 'slots', 'locale', 'connection'],
    }
    return module.exports
  },
})
