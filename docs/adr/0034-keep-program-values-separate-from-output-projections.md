# Keep program values separate from output projections

## Problem

An isolated PTC computation can return a value that the parent must continue computing with. DSH's outer execution seam accepts JSON-safe output, so its readable rendering of a BigInt or cyclic graph cannot also be the parent program result. An unsupported transfer likewise has different consequences before dispatch, after a binding completes, and after a cell computes its result.

## Decision

Plugin-owned isolated `code.run` uses the canonical completion of its settled child runtime, decoded by the existing PTC Value V1 codec. The child owns an independent binding root and is disposed after settlement. The private `runTentative` program-completion option validates canonical graph admission without generating model presentation; a sparse graph may fit transfer limits while its unused rendering would exceed them. Only the native execution seam consumes its public JSON-safe projection. An explicit `return undefined` has a `result` property; a child without a return does not. Existing native `run_code` members retain their owner-defined result contract, including when their execution re-enters the plugin. Legacy upstream execution retains its previous contract.

Journal calls already store canonical argument and result envelopes. Cold replay returns exactly the recorded value without redispatching child computation or external effects. Historical codec refusal diagnostics remain readable only when the actual refusal or a codec-owned legacy message exactly matches their recorded diagnostic; arbitrary errors do not acquire that compatibility. Historical strings remain strings; neither a language generation nor a wire migration is required because replay does not recompute the changed bridge result. Renderer text is never decoded or inspected to guess an encoding.

PTC Value V1 retains its explicit support domain. Codec-owned failures retain private structured categories (`unsupported`, `shape`, `budget`) and paths. Native Node brand checks identify known excluded data types without consulting user getters, `toJSON`, constructor names or `Symbol.toStringTag`. Prototype admission uses data descriptors; a hostile or unknown prototype remains unsupported. Proxy reflection in actual encoding still belongs to worker execution and budgets; diagnostic classification does not perform additional reflection.

Parameters reject before dispatch. Result encoding happens only after the owner call completes and reports that fact, possible effects and the absence of automatic retry. A completion encoding failure preserves the live worker and supplies category-specific help. Stable guidance distinguishes direct result transfer, live computation and native tool JSON contracts. Native JSON serialization and BigInt arithmetic retain their own errors.

## Alternatives considered

**Decode rendered strings.** Ordinary strings overlap with renderer output; parsing cannot recover value identity or distinguish a historical string from a canonical value.

**Return rich values through the public DSH seam.** The seam's JSON-safe contract does not permit this. A private canonical child completion already exists and provides the necessary boundary without changing Host packages or public dispatch.

**Expand V1 using structuredClone or Node v8 serialization.** Maintained platform serializers support more data types, but their semantics differ from V1: structured clone can read accessors, normalize class instances and descriptors, and v8 binary output does not provide this project's closed canonical JSON envelope and versioned admission guarantees. Type expansion requires a separately specified generation covering references, own properties, intrinsic state, budgets and historical decoding. Neither platform support nor a diagnostic repair proves those semantics. V1 is retained rather than silently widening or lossy-stringifying it.

**Convert BigInt to Number or JSON text automatically.** Conversion can lose precision or turn computation into string concatenation. Native tool schemas remain authoritative; callers select meaningful explicit representations at those boundaries.

## Consequences

Supported child values retain their types and graph relationships across plugin IPC, while parent and child bindings stay isolated. Unsupported live values remain usable inside their worker, with actionable transfer diagnostics instead of undifferentiated budget advice. This does not add support for Date, Map, class instances or live resources, or imply that a failed transfer undoes an external effect. The wire format, native owner authority and historical recorded results remain unchanged.
