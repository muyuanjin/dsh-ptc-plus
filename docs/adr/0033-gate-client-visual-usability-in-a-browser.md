# Gate Client Visual Usability In A Browser

## Problem

JSDOM can verify component classes and callbacks while the browser paints unusable controls. Optional smoke scripts and saved screenshots leave key style regressions outside normal verification and provide no automatic verdict for focus or disabled feedback.

## Decision

The standard local and CI verification entries run one Client suite followed by deterministic browser layout and visual assertions against fresh actual-renderer fixtures. A shared bounded usability oracle owns contrast, action dimensions, reachability and state feedback. Fault counterexamples retain actual DOM classes and handlers and must be rejected. Browser prerequisites are explicit and absence fails verification. The coverage inventory and exceptions are owned by [the Client visual contract](../client-visual-contract.md).

Packed official-DSH acceptance remains a separate integration obligation under [ADR 0017](0017-track-the-latest-dsh-public-surface.md). It reuses the oracle on actual Host theme surfaces; fixture palettes do not establish Host compatibility. These checks do not change DSH authority, runtime state, program values or the model's tool surface.

## Alternatives considered

**Keep browser checks opt-in.** This permits a standard green gate while CSS is absent or state feedback is lost, which does not satisfy the Client usability obligation.

**Freeze full-page screenshot baselines.** Such baselines couple plugin acceptance to upstream typography and rendering pixels. Bounded computed-style and hit assertions directly test the product obligation, while screenshots remain useful diagnostics.

**Run every browser script independently in the gate.** The layout script would rerun the complete Client suite. Sharing a single fresh fixture generation preserves current-source evidence without that duplication.

## Consequences

Contributors need the locked Playwright Chromium installation before the full gate. Browser checks add work to verification and fail when their prerequisites are unavailable. Their guarantee is bounded by the declared controls and states; extending a UI responsibility requires extending its inventory and counterexamples rather than promising all future styles.
