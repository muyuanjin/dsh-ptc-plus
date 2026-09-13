/** Native or external fixtures do not contribute plugin coverage evidence. */
export function uncoveredEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment)
      .filter(([name]) => name.toLowerCase() !== 'node_v8_coverage')),
    NODE_V8_COVERAGE: '',
  }
}
