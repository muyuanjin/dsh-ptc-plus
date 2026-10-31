import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { provideSandboxPolicyFixture, provideWorkingDirectoryFixture } from './host-service-fixture.js'

/**
 * Select the tool executor a test's composition runs through.
 *
 * A tool registry no longer has a mode of its own: the selected release mounts an executor
 * and the registry renders whatever that executor describes. A fixture that only needs a
 * tool table to assemble mounts the native executor; one that exercises PTC dispatch mounts
 * the PTC executor and must provide the `ptcRuntime` service it injects.
 *
 * The native executor's second constructor argument is its concurrency policy, a function
 * the batch scheduler calls — passing an options object there replaces the policy and every
 * dispatch then fails with `maxParallel is not a function`.
 */
export function attachNativeExecutor(ctx, maxParallel) {
  return ctx.tools.setExecutor(maxParallel === undefined
    ? new NativeToolExecutor(ctx)
    : new NativeToolExecutor(ctx, maxParallel))
}

export function attachPtcExecutor(ctx, config = {}) {
  // A confined PTC runtime resolves one file policy per call and resolves the session's
  // working directory before it executes, so a fixture that mounts the PTC executor states
  // both. The full-access default keeps every fixture's operations unconfined.
  provideSandboxPolicyFixture(ctx)
  provideWorkingDirectoryFixture(ctx)
  return ctx.tools.setExecutor(new PtcExecutor(ctx, config))
}

/**
 * Dispatch one call through the selected executor and return that call's settlement.
 *
 * The registry delegates a whole batch and reports one settlement per call, so a fixture
 * that dispatches a single call asks for a batch of one and reads that call's result. The
 * returned shape is the one the executor settled: `{ isError, content, value, error }`.
 */
export async function runTool(ctx, call) {
  // A batch call is the assistant's own call block: the registry reads `id` and parses
  // `arguments` as text, so a fixture that hands over an object or a `callId` key produces
  // an execution with no identity — and the nested dispatch record it writes is then
  // rejected as unencodable.
  const batch = await ctx.tools.execute({
    agent: call.agent,
    signal: call.signal,
    calls: [{ id: call.callId, name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}) }],
  })
  return batch.results[0]?.result
}
