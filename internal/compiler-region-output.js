import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import { createGeneratedNameAllocator } from './binding-pattern.js'
import { applySourceEdits, identitySourceMap, createSourceMapBuilder, mappedSourceTransform, sourceLineStarts } from './source-position-map.js'

const REGION_LENGTH = 32768

/** Scheduling closures end with compilation; only source spans reach runtime. */
export const sourceRegionData = facts => facts === undefined ? undefined : { regions: facts.regions }

function collectSourceFeatures(node, features) {
  if (node.decorators?.length || node.type === 'ClassAccessorProperty') features.decorated = true
  if (node.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using')) features.resources = true
  if (node.type === 'WithStatement' || node.type === 'CallExpression'
    && node.callee.type === 'Identifier' && node.callee.name === 'eval') features.lexicalDynamic = true
}

/** Lowering decisions use parsed syntax, including features in nested bodies. */
export function sourceFeatures(tree) {
  const features = { decorated: false, resources: false, lexicalDynamic: false }
  t.traverseFast(tree, node => collectSourceFeatures(node, features))
  return features
}

/** Native lowering has already established syntax and declaration ownership.
 * Index its source without creating a whole-module Babel path/scope graph. */
export function indexSourceRegions(source, options, tree = parse(source, options)) {
  const regions = []
  const features = { decorated: false, resources: false, lexicalDynamic: false }
  const walk = (node, context) => {
    if (!node) return
    collectSourceFeatures(node, features)
    if (t.isFunction(node)) context = { ...context, async: node.async, generator: node.generator, labels: [] }
    if (node.type === 'LabeledStatement') context = { ...context, labels: [...context.labels ?? [], node.label.name] }
    if (t.isClass(node)) context = { ...context, strict: true, privateNames: [...context.privateNames ?? [],
      ...node.body.body.filter(member => member.key?.type === 'PrivateName').map(member => member.key.id.name)] }
    if (node.directives?.some(item => item.value.value === 'use strict')) context = { ...context, strict: true }
    if (node.type === 'BlockStatement' && node.end - node.start > REGION_LENGTH / 2) {
      regions.push({ start: node.start, end: node.end, kind: 'block', ...context })
    }
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      let first, last
      for (const statement of node.body) {
        first ??= statement.start
        last = statement.end
        if (last - first >= REGION_LENGTH / 2) {
          regions.push({ start: first, end: last, kind: 'statements', top: node.type === 'Program', ...context })
          first = undefined
        }
      }
      if (first !== undefined && first !== node.body[0]?.start) {
        regions.push({ start: first, end: last, kind: 'statements', top: node.type === 'Program', ...context })
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) { for (const item of child) walk(item, context) }
      else walk(child, context)
    }
  }
  walk(tree.program, { strict: options.sourceType === 'module' })
  return { regions, allocate: createGeneratedNameAllocator(tree), ...features }
}

/** Scheduling uses typed output slots, never scans source for brace-like text. */
export function sourceRegionPlan(source, facts) {
  const root = { start: 0, end: source.length, kind: 'program', children: [] }
  const stack = [root]
  for (const fact of [...facts?.regions ?? []].sort((a, b) => a.start - b.start || b.end - a.end)) {
    while (stack.length > 1 && fact.start >= stack.at(-1).end) stack.pop()
    while (stack.length > 1 && fact.end > stack.at(-1).end) stack.pop()
    const parent = stack.at(-1)
    if (parent.start === fact.start && parent.end === fact.end) continue
    const region = { ...fact, children: [] }
    parent.children.push(region)
    stack.push(region)
  }
  const trim = region => {
    if (region.end - region.start <= REGION_LENGTH) region.children = []
    else for (const child of region.children) trim(child)
  }
  trim(root)
  return root
}

export function regionInput(source, region, options) {
  const changes = region.children.map((child, index) => ({ start: child.start - region.start,
    end: child.end - region.start, text: '{}', child, index }))
  const body = source.slice(region.start, region.end)
  const outlined = applySourceEdits(body, identitySourceMap(body.length), changes)
  const top = (region.kind === 'program' || region.top && region.kind === 'statements')
    && !(options.wrapCommonJs && options.sourceType === 'commonjs')
  let prefix = '', suffix = ''
  if (!top) {
    prefix = `${region.async ? 'async ' : ''}function${region.generator ? '*' : ''} __ptc_region__(){`
    if (region.strict) prefix += '"use strict";'
    for (const label of region.labels ?? []) prefix += `${label}:`
    prefix += 'while(0){'
    suffix = '\n}}'
  }
  const code = prefix + outlined.code + suffix
  const parserOptions = { ...options, strictMode: region.strict ?? options.strictMode,
    allowSuperOutsideMethod: true, allowUndeclaredExports: options.sourceType === 'module', errorRecovery: true }
  const tree = parse(code, parserOptions)
  for (const error of tree.errors) {
    if (error.reasonCode === 'InvalidPrivateFieldResolution' && region.privateNames?.includes(error.details.identifierName)) continue
    throw error
  }
  let selected = tree.program
  if (!top) {
    let statement = tree.program.body[0].body.body[0]
    while (statement.type === 'LabeledStatement') statement = statement.body
    selected = statement.body
  }
  const slots = []
  let delta = prefix.length
  for (const change of changes) {
    slots.push({ start: change.start + delta, end: change.start + delta + change.text.length, child: change.child })
    delta += change.text.length - (change.end - change.start)
  }
  const mappings = createSourceMapBuilder()
  for (const item of outlined.sourceMap) mappings.push({ ...item,
    originalStart: item.originalStart + region.start, originalEnd: item.originalEnd + region.start })
  let mapped = { code: outlined.code, sourceMap: mappings.finish() }
  if (prefix) mapped = applySourceEdits(mapped.code, mapped.sourceMap, [
    { start: 0, end: 0, text: prefix }, { start: mapped.code.length, end: mapped.code.length, text: suffix },
  ])
  return { tree, selected, code, prefix, suffix, slots, outlined, region, sourceMap: mapped.sourceMap }
}

/** Edits retain region ownership when a phase changes tokens or inserts helpers. */
export function applyRegionEdits(mapped, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const position = (offset, after) => {
    let delta = 0
    for (const edit of ordered) {
      if (edit.end > offset || edit.end === offset && edit.start === edit.end && !after) break
      delta += (edit.text?.length ?? 0) - (edit.end - edit.start)
    }
    return offset + delta
  }
  return { ...mapped, ...applySourceEdits(mapped.code, mapped.sourceMap, ordered),
    ...(mapped.sourceRegions === undefined ? {} : { sourceRegions: { ...mapped.sourceRegions,
      regions: mapped.sourceRegions.regions.map(region => ({ ...region,
        start: position(region.start, true), end: position(region.end, false) })) } }) }
}

export function visitRegionSource(mapped, options, visitor, select) {
  const root = sourceRegionPlan(mapped.code, mapped.sourceRegions)
  const visit = region => {
    if (select === undefined || select(region)) visitor(regionInput(mapped.code, region, { ...options, attachComment: false }))
    for (const child of region.children) visit(child)
  }
  visit(root)
}

/** Compose exact child slots after the maintained generator emits their parent. */
export function transformRegionSource(mapped, options, transform, inspectOutput) {
  const root = sourceRegionPlan(mapped.code, mapped.sourceRegions)
  const visit = region => {
    let input = regionInput(mapped.code, region, options)
    let generated = transform(input)
    const emission = generated.sourceOffsets === undefined
      ? mappedSourceTransform(input.code, input.sourceMap, generated)
      : applySourceEdits(input.code, input.sourceMap,
        [{ start: 0, end: input.code.length, text: generated.code, mappings: generated.sourceOffsets }])
    const starts = new Map(input.slots.map(slot => [slot.start, slot]))
    const ends = new Map(input.slots.map(slot => [slot.end - 1, slot]))
    let outputSlots = generated.slotRanges
    let output = inspectOutput !== undefined || outputSlots === undefined && input.slots.length
      ? regionInput(generated.code, { ...region, start: 0, end: generated.code.length, children: [] },
        { ...options, attachComment: false }) : undefined
    if (outputSlots === undefined && input.slots.length) {
      const inputStarts = sourceLineStarts(input.code), outputStarts = sourceLineStarts(generated.code)
      const points = generated.mappingPoints ?? generated.rawMappings.filter(item => item.original).map(item => [
        outputStarts[item.generated.line - 1] + item.generated.column,
        inputStarts[item.original.line - 1] + item.original.column,
      ])
      const origins = new Map(points)
      outputSlots = []
      t.traverseFast(output.selected, node => {
        if (node.type !== 'BlockStatement' || node.body.length || node.directives.length) return
        const start = node.start - output.prefix.length, end = node.end - output.prefix.length
        const first = starts.get(origins.get(start)), last = ends.get(origins.get(end - 1))
        if (first && last && first !== last) throw new Error('compiler changed a typed source-region boundary')
        const slot = first ?? last
        if (slot) outputSlots.push({ sourceStart: slot.start, start, end })
      })
    }
    for (const fact of outputSlots ?? []) {
      const slot = starts.get(fact.sourceStart)
      if (slot) {
        if (slot.generatedStart !== undefined) throw new Error('compiler duplicated a typed source-region slot')
        Object.assign(slot, { generatedStart: fact.start, generatedEnd: fact.end, prefix: fact.prefix })
      }
    }
    const slots = input.slots, emittedCallables = inspectOutput === undefined
      ? generated.callableRanges ?? [] : inspectOutput(output)
    input = undefined
    generated = undefined
    output = undefined
    const replacements = slots.map(slot => {
      if (slot.generatedStart === undefined || slot.generatedEnd === undefined) throw new Error('compiler lost a typed source-region slot')
      let output = visit(slot.child)
      if (slot.prefix) {
        output = { ...output, ...applySourceEdits(output.code, output.sourceMap, [{ start: 0, end: 0, text: slot.prefix }]),
          regions: output.regions.map(fact => ({ ...fact, start: fact.start + slot.prefix.length, end: fact.end + slot.prefix.length })),
          callableRanges: output.callableRanges.map(fact => ({ ...fact, start: fact.start + slot.prefix.length, end: fact.end + slot.prefix.length })),
        }
      }
      return { start: slot.generatedStart, end: slot.generatedEnd, output, fact: slot.child }
    }).sort((a, b) => a.start - b.start)
    const code = [], sourceMap = createSourceMapBuilder(), regions = [], callableRanges = []
    let cursor = 0, offset = 0
    const append = (text, mappings, from = 0, to = text.length) => {
      code.push(text.slice(from, to))
      for (const item of mappings) {
        if (item.generatedEnd <= from) continue
        if (item.generatedStart >= to) break
        const left = Math.max(from, item.generatedStart), right = Math.min(to, item.generatedEnd)
        const linear = item.generatedEnd - item.generatedStart === item.originalEnd - item.originalStart
        sourceMap.push({ generatedStart: offset + left - from, generatedEnd: offset + right - from,
          originalStart: item.originalStart + (linear ? left - item.generatedStart : 0),
          originalEnd: linear ? item.originalStart + right - item.generatedStart : item.originalEnd })
      }
      offset += to - from
    }
    for (const replacement of replacements) {
      append(emission.code, emission.sourceMap, cursor, replacement.start)
      const start = offset
      for (const fact of replacement.output.regions) regions.push({ ...fact, start: fact.start + start, end: fact.end + start })
      for (const fact of replacement.output.callableRanges) callableRanges.push({ ...fact, start: fact.start + start, end: fact.end + start })
      append(replacement.output.code, replacement.output.sourceMap)
      const { children, ...fact } = replacement.fact
      regions.push({ ...fact, start, end: offset })
      cursor = replacement.end
    }
    append(emission.code, emission.sourceMap, cursor)
    const position = value => {
      let delta = 0
      for (const item of replacements) {
        if (value < item.end) break
        delta += item.output.code.length - (item.end - item.start)
      }
      return value + delta
    }
    for (const fact of emittedCallables) callableRanges.push({ ...fact,
      start: position(fact.start), end: position(fact.end) })
    return { code: code.join(''), sourceMap: sourceMap.finish(true), regions, callableRanges }
  }
  const output = visit(root)
  return { code: output.code, sourceMap: output.sourceMap, callableRanges: output.callableRanges,
    sourceRegions: { ...mapped.sourceRegions, regions: output.regions } }
}

/** Validate each emitted grammar region without reparsing expanded whole output. */
export function validateRegionSource(mapped, options) {
  visitRegionSource(mapped, options, () => {})
}
