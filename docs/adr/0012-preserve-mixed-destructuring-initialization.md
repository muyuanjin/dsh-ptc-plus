# Preserve Mixed Destructuring Initialization

The historical behavior below is retained by the frozen `legacy-v1` compiler. New cells use the logical identities and complete declarator publication in [ADR 0025](0025-use-versioned-logical-binding-identities.md).

## Problem

Loose cross-cell redeclarations must assign names that already exist while introducing fresh names from one top-level destructuring declarator. A text-level whole-pattern assignment can preserve simple values, but it changes JavaScript binding initialization when a default expression refers to an earlier fresh binding, and a generated helper can also change top-level `await` or initializer ordering.

## Decision

`internal/legacy-repl-convenience.js` evaluates the initializer as a helper argument, then runs the original destructuring pattern unchanged inside the helper. This leaves initializer references outside the new pattern scope while the JavaScript engine owns binding order, TDZ, computed keys, defaults, iterator handling, lexical shadowing, and abrupt completion inside the pattern. After the complete pattern succeeds, the helper passes every bound value positionally to a commit callback: existing names are assigned to their session bindings and fresh values are returned to one outer declaration. Arrays carry the positional values so names such as `__proto__` have no property-key semantics. A pattern containing direct `await` uses an async helper; a synchronous pattern stays synchronous. Declarator replacements remain in source order, and both lexical and `var` mixed declarations use the same native-pattern model with their corresponding outer declaration kind.

## Alternatives considered

**Rename existing bindings inside the pattern.** This can produce the required assignments for simple patterns, but correctly rewriting references requires a complete JavaScript scope transform. Defaults with nested lexical declarations and computed keys expose the gap, so a local reference walker is not a sound compiler boundary.

**Keep one whole-pattern assignment for every declaration.** This is shorter, but fresh names require temporaries and the assignment form does not reproduce lexical initialization or TDZ.

**Manually lower every object and array pattern.** This could assign existing names at each binding step, but it would duplicate iterator, getter, rest, computed-key, default, and abrupt-completion semantics already implemented by JavaScript, creating a second destructuring engine.

**Reject all mixed patterns.** Rejection is fail-safe, but it abandons the core REPL promise that ordinary TypeScript destructuring can continue across cells and provides no value for the common, semantically representable case.

## Consequences

Native destructuring remains the semantic authority instead of a plugin-owned scope or pattern compiler. Existing bindings are committed only after the complete pattern succeeds; fresh lexical names keep their TDZ while the initializer is evaluated. Focused tests cover declarator order, TDZ, same-pattern defaults, nested lexical shadowing, computed keys, `__proto__`, existing-binding initializer scope, `var`, and awaited patterns.
