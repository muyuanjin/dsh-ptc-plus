import { transformSync } from 'amaro'

export const USER_BINDING_TRANSFORM = 'amaro@1.1.11'

/** Keep binding-module lowering independent of the Host's experimental transform API. */
export function transformTypeScriptModule(source) {
  try {
    return transformSync(source, { mode: 'transform', sourceMap: false }).code
  } catch (error) {
    if (error instanceof Error) throw error
    throw new SyntaxError(error.message, { cause: error })
  }
}
