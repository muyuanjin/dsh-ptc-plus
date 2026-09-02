const GENERATED_RUN_CODE_DESCRIPTION = 'Execute the next TypeScript cell in this session'
export const GENERATED_RUN_CODE_DESCRIPTION_KEY = 'dshPtcPlusRunCodeDescription'

// Keep presentation provenance outside the canonical JSON argument graph.
const generatedArguments = new WeakSet()

export function markGeneratedRunCodeArguments(argumentsValue) {
  if (argumentsValue !== null
    && (typeof argumentsValue === 'object' || typeof argumentsValue === 'function')) {
    generatedArguments.add(argumentsValue)
  }
  return argumentsValue
}

export function generatedRunCodeExecutionArguments(argumentsValue) {
  markGeneratedRunCodeArguments(argumentsValue)
  return markGeneratedRunCodeArguments({
    ...argumentsValue,
    description: GENERATED_RUN_CODE_DESCRIPTION,
  })
}

export function generatedRunCodeDescriptionMeta(argumentsValue, meta) {
  if (!generatedArguments.has(argumentsValue)) return meta
  const base = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta
    : meta === undefined ? {} : { value: meta }
  return {
    ...base,
    [GENERATED_RUN_CODE_DESCRIPTION_KEY]: GENERATED_RUN_CODE_DESCRIPTION,
  }
}

export { GENERATED_RUN_CODE_DESCRIPTION }
