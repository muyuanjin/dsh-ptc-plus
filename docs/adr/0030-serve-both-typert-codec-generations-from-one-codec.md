# 0030 Serve Both TYPERT Codec Generations from One Codec

Date: 2026-09-18

## Problem

PTC Plus publishes its Remote services through DSH's TYPERT registry, and that registry validates every strict codec it is handed before any endpoint exists. The codec carries the decoder for one wire member, and DSH changed where the host reads it: the preceding generation keeps the decoder on `codec.schema` and evaluates `codec.schema.parse(value)`, while the current generation keeps a `create()` factory, rejects a codec without it, and evaluates `codec.create().parse(value)`. The plugin published only the preceding shape, so a release that requires `create` fails registration inside the plugin's own activation: the Host entry never activates and the Client entry reports a failed fiber, although every import, load check, and type-level use still succeeds.

## Decision

`internal/typert-codec-compat.js` owns the codec shape PTC Plus publishes. `strictCodec({ typeSymbol, schema })` returns one codec that carries both members — `schema` for the preceding generation and `create()` for the current one — and both resolve to the same decoder object, which presents the maintained schema runtime as the `parse` member each generation evaluates.

Each generation validates only the member it owns and ignores the other, so one published contract serves whichever shape the installed host implements. Compatibility follows the live acceptance behavior of the registry rather than a release version, and the decoder is published once, so a host that reads both members cannot obtain two different decoders for one wire member.

CI registers the packed contract with the installed host's own registry on both the stable and alpha channels (`scripts/dsh-rpc-contract-smoke.mjs`), so a generation that changes this validation fails the packaging check instead of reaching users.

## Alternatives Considered

1. **Detect the installed generation and publish the matching member.** Rejected: the registry exposes no capability flag or version-free signal for this, so detection would end up as a DSH version gate — the compatibility mechanism [ADR 0017](0017-track-the-latest-dsh-public-surface.md) replaces. The two shapes are also not mutually exclusive, so nothing forces a choice.
2. **Publish only `create()` and drop `schema`.** Rejected: the preceding generation rejects a codec without `schema.parse`, so that trades one release's compatibility for another's instead of covering both.
3. **Keep a second descriptor builder for the current generation.** Rejected: two builders would drift, and the wire contract — type symbols, parameter names, wire fields, the shared result envelope — is one contract that must stay identical for both generations.
4. **Rely on the CI import and load check to catch this.** Rejected: both pass with an unacceptable codec. The failure appears only when the registry validates a registration, which happens inside plugin activation in the Host and in the browser.
5. **Publish the codec members lazily through getters that probe the host.** Rejected: a getter would have to resolve the host's validation rule per access, and a codec is read while the host builds its own records — a probe there is both fragile and unnecessary when both members can simply be correct.

## Consequences

One plugin build serves the stable and alpha channels for this surface, and the compatibility rule lives in a single module with the decoder published once. A future generation that requires another member, or that rejects a codec carrying a member it does not know, needs this owner updated; the regression test is CI's registration against the installed registry, which fails on the channel that changed instead of on the user's machine. The decoder keeps the project's maintained schema runtime, so a host that validates payloads itself still evaluates the same semantics the plugin's own tests exercise through both members.
