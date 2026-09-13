import { writeFileSync } from 'node:fs'
import { serialize } from 'node:v8'
import { compilerWorkerCache, compileDynamicSource, prepareProgram } from '../internal/compiler-service.js'

// Warm compiler code only. No submitted program or execution realm is run.
if (process.env.NODE_V8_COVERAGE) throw new Error('compiler bytecode preparation requires coverage to be disabled')
prepareProgram('const value=42; return value', { languageSemantics: 'stateful-v1' })
compileDynamicSource('40+2')
writeFileSync(process.argv[2], serialize(compilerWorkerCache()))
