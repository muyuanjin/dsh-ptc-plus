import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'

export function isDocumentationPath(filename) {
  return ['AGENTS.md', 'CONTEXT.md', 'README.md', 'README.en.md'].includes(filename)
    || /^docs\/.+\.md$/.test(filename)
}

// Compare the complete source inventory, including new files and file modes.
// A Markdown fixture, executable Markdown file or mixed change uses full verification.
export function documentationChanges(previous, current) {
  const entries = list => new Map(list.map(entry => [entry.path.toString('hex'), entry]))
  const before = entries(previous)
  const after = entries(current)
  const files = []
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key)
    const next = after.get(key)
    if (old?.identity === next?.identity) continue
    const raw = (next ?? old).path
    const filename = raw.toString('utf8')
    if (!Buffer.from(filename).equals(raw) || !isDocumentationPath(filename)
      || [old, next].some(entry => entry && !entry.identity.startsWith('100644 blob '))) return undefined
    files.push(filename)
  }
  return files.length ? files.sort() : undefined
}

function visit(node, callback) {
  callback(node)
  for (const child of node.children ?? []) visit(child, callback)
}

function localTarget(root, filename, url) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return undefined
  const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0])
  return pathname ? path.resolve(path.dirname(path.join(root, filename)), pathname) : path.join(root, filename)
}

function documentReferences(root, filename, source) {
  const links = []
  const commands = []
  const tree = fromMarkdown(source)
  visit(tree, node => {
    if (['link', 'image', 'definition'].includes(node.type)) {
      const target = localTarget(root, filename, node.url)
      if (target) links.push({ target, line: node.position.start.line })
    }
    if (node.type === 'inlineCode' || node.type === 'code') {
      for (const match of node.value.matchAll(/\bnpm run ([\w:.-]+)([^\w:.-]|$)/g)) {
        if (match[2] !== '<') commands.push({ name: match[1], line: node.position.start.line })
      }
    }
  })
  return { links, commands }
}

export async function verifyDocumentation(root, { files, inventory }) {
  const changed = new Set(files.map(filename => path.join(root, filename)))
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const errors = []
  let documents = 0
  for (const filename of inventory.filter(isDocumentationPath)) {
    const source = await readFile(path.join(root, filename), 'utf8')
    const { links, commands } = documentReferences(root, filename, source)
    if (!changed.has(path.join(root, filename)) && !links.some(link => changed.has(link.target))) continue
    documents += 1
    for (const { target, line } of links) {
      try {
        await stat(target)
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        errors.push(`${filename}:${line}: missing local link target ${path.relative(root, target)}`)
      }
    }
    for (const { name, line } of commands) {
      if (!Object.hasOwn(manifest.scripts ?? {}, name)) errors.push(`${filename}:${line}: unknown npm script ${name}`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return { kind: 'documentation', files, documents }
}
