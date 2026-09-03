# Persist Cell Rewrite Policy

## Problem

Durable replay prepares the original cell source again. AST module rewrites and both REPL redeclaration conveniences are configuration-controlled, so using the current profile during replay can reject a cell that was durable when it was recorded or infer the wrong binding assignability. Replay would then discard recoverable bindings even though the journal still proves the cell's calls and completion.

## Decision

Journal version 4 replaces `bindingMode` with the closed `bindingPolicy` object containing the exact `variableRedeclarations` and `functionClassRedeclarations` booleans used to prepare the cell. It retains `rewritePolicy` with the three module and mixed-declaration rewrite booleans, and adds the closed `moduleSemantics.defaultExportBinding` value. Current cells record `live-readonly`; this is a source-lowering generation, not a user setting. Live journals capture both active policies and the fixed module semantics; replay passes every recorded value to `prepareProgram`. These objects participate in normalization and semantic equality, are frozen with the journal, and are required by the closed schema. A profile change therefore affects only new cells; existing durable nodes retain the language policy, module lowering, and writable-binding provenance under which they were evaluated.

The journal decoder also owns the predecessor adapters. Versions 1 through 3 retain their original closed field sets as inputs and normalize to version 4. Their `bindingMode` maps exactly to `variableRedeclarations`; `functionClassRedeclarations` is always `false` because those language pipelines did not implement the feature. They receive `legacy-variable` default-export semantics so loose journals preserve the historically writable generated binding and strict journals preserve its const behavior. Version 1 receives all three later rewrite switches as disabled and its string call-ID confirmations become event sequences only when the enclosing session log contains exactly one earlier unjournaled `run_code` call with that identity. Missing or repeated candidates are ambiguous, so they cannot prove old state and form an unknown recovery boundary. Versions 2 and 3 retain their recorded `rewritePolicy`; unsupported non-numeric predecessor confirmations receive the same conservative contraction. Per [ADR 0007](0007-separate-worker-transport-from-session-semantics.md), rejecting predecessor state evidence does not make historical metadata an availability gate for the current valid call.

## Alternatives considered

**Persist transformed source.** This would avoid rerunning the rewrite pass, but it duplicates generated code in the session log, makes source provenance less direct, and couples the durable protocol to an analyzer intermediate representation.

**Reject recovery when rewrite settings differ.** This preserves semantic caution, but throws away replayable history even when the original source and recorded policy are sufficient to reconstruct it.

**Read the current profile during replay.** This keeps the journal small, but makes durable recovery depend on mutable deployment configuration and causes valid historical cells to become unrecoverable after a configuration change.

**Infer the default-export lowering from source or journal version during replay.** Source does not identify which implementation generation evaluated it, while version-derived behavior becomes implicit protocol state. Persisting the closed semantic value makes migration explicit and keeps replay deterministic.

**Accept every predecessor confirmation by call ID.** Preserving those values would require replay to guess which event a reused provider call ID denotes. Only the version 1 adapter with a unique enclosing session event has sufficient evidence, so broader migration would weaken the event-sequence contract owned by [ADR 0007](0007-separate-worker-transport-from-session-semantics.md).

## Consequences

The current journal schema is version 4. Replay remains source-based and deterministic while configuration changes no longer invalidate durable cells or alter reconstructed binding assignability. Version 1 histories retain the predecessor rewrite behavior and migrate only uniquely identified confirmations; versions 2 and 3 retain their recorded rewrite policy. Every predecessor fixes function/class replacement to disabled and default-export lowering to `legacy-variable` instead of guessing from current behavior. Ambiguous identity remains unsupported recovery input rather than receiving guessed defaults. New profile settings apply at the next live cell boundary.
