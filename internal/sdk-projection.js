/** Adapt the host program SDK without weakening the declared direct tool surface. */
import { parse } from '@babel/parser'

const PROJECTION_ERROR = 'ptc-plus: incompatible tools SDK projection: '
const TYPESCRIPT_FENCE = '```ts\n'

function incompatible(message, cause = undefined) {
  return new Error(`${PROJECTION_ERROR}${message}`, cause === undefined ? undefined : { cause })
}

function lineStart(source, offset) {
  return source.lastIndexOf('\n', offset - 1) + 1
}

function memberName(member) {
  if (member.type !== 'TSPropertySignature') return undefined
  if (member.key.type === 'Identifier') return member.key.name
  if (member.key.type === 'StringLiteral') return member.key.value
  return undefined
}

function supportedFence(source) {
  const starts = []
  for (let offset = 0; offset < source.length;) {
    const start = source.indexOf(TYPESCRIPT_FENCE, offset)
    if (start < 0) break
    if (start === 0 || source[start - 1] === '\n') starts.push(start)
    offset = start + TYPESCRIPT_FENCE.length
  }
  if (starts.length !== 1) {
    throw incompatible(`expected exactly one ${JSON.stringify(TYPESCRIPT_FENCE.trim())} fence`)
  }
  const codeStart = starts[0] + TYPESCRIPT_FENCE.length
  const codeEnd = source.indexOf('\n```', codeStart)
  if (codeEnd < 0) throw incompatible('the TypeScript fence is not closed')
  return { codeStart, codeEnd }
}

/** Project the selected cell grammar and direct-only member without rewriting tool guidance. */
export function projectProgramSdk(nativeSdk, { excludedName = 'edit_run_code', languageSemantics = 'legacy-v1' } = {}) {
  if (typeof nativeSdk !== 'string') return ''
  if (languageSemantics !== 'legacy-v1' && nativeSdk.startsWith('## Writing code for run_code\n')) {
    // Only the Host's introduction describes the cell grammar. Identical text
    // in SDK member documentation remains the native tool owner's guidance.
    const fence = nativeSdk.indexOf(TYPESCRIPT_FENCE)
    if (fence >= 0) {
      nativeSdk = nativeSdk.slice(0, fence).replace(
        '`code` — the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped)',
        '`code` — a PTC Plus TypeScript cell (runtime `enum` and namespaces are supported; type annotations are advisory)',
      ) + nativeSdk.slice(fence)
    }
  }
  if (!nativeSdk.includes(excludedName)) return nativeSdk

  const { codeStart, codeEnd } = supportedFence(nativeSdk)
  const code = nativeSdk.slice(codeStart, codeEnd)
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
  } catch (error) {
    throw incompatible('the TypeScript fence could not be parsed', error)
  }

  const removals = []
  for (const interfaceName of ['ToolArgsMap', 'ToolOutputMap']) {
    const declarations = ast.program.body.filter(statement => (
      statement.type === 'TSInterfaceDeclaration' && statement.id.name === interfaceName
    ))
    if (declarations.length !== 1) {
      throw incompatible(`expected exactly one ${interfaceName} interface`)
    }
    const declaration = declarations[0]
    const members = declaration.body.body.filter(member => memberName(member) === excludedName)
    if (members.length !== 1) {
      throw incompatible(`expected exactly one ${excludedName} member in ${interfaceName}`)
    }
    const member = members[0]
    if (declaration.body.body.length === 1) {
      removals.push([declaration.body.start + 1, declaration.body.end - 1])
      continue
    }
    const commentStart = member.leadingComments?.[0]?.start
    const startOffset = commentStart ?? member.start
    const start = lineStart(code, startOffset)
    let end = member.end
    if (code[end] === '\n') end += 1
    removals.push([start, end])
  }

  let projectedCode = code
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    projectedCode = projectedCode.slice(0, start) + projectedCode.slice(end)
  }
  const projected = nativeSdk.slice(0, codeStart) + projectedCode + nativeSdk.slice(codeEnd)
  if (projected.includes(excludedName)) {
    throw incompatible(`residual ${excludedName} token remains after projection`)
  }
  return projected
}
