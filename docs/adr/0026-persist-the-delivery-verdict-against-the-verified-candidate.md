# Persist the delivery verdict against the verified candidate

## Problem

A complete-tree independent review returns a sampled conclusion for one tree state. Nothing bound that conclusion to the candidate, so the same source bytes could be reported clean by one review and expose three reproducible defects to the next, and a clean verdict never stopped the following review from starting. The verification proof already bound `npm run check` to `{HEAD, fingerprint}`, but the review stayed a transcript outside the commit gate, and the gate allowed a commit whenever no proof, no ledger or only a historical clean review existed.

## Decision

The delivery gate is a persisted verdict in checkout-local Git metadata (`review-findings/verdict`) holding `{schema, status, head, fingerprint, base, evidence}`. `status` is `clean`; `head` and `fingerprint` are the frozen candidate the independent complete review examined; `base` is the scope base commit and must be an ancestor of `HEAD`; `evidence` names the retained copy of the original review report and its SHA-256. `recordReviewVerdict` is the only writer: it requires both the `HEAD` and the fingerprint captured before the review, refuses a candidate where either changed, refuses any report whose last non-empty line is not `VERDICT: NO FINDINGS`, and copies the report into `review-findings/evidence` before hashing it. A report that is not clean retires the standing proof and verdict instead of leaving an earlier clean verdict in force. `preCommitReviewLedger` is fail-closed and requires a proof for the current `HEAD`, equal source and index fingerprints, and a clean verdict whose head, fingerprint and scope cover that candidate and whose evidence still hashes to the recorded value. An absent ledger, an absent proof or documentation-only work is not an exemption. A proof whose `HEAD` moved is retired together with its verdict, and a verdict that no longer matches the verified candidate is discarded without touching the proof; either case blocks the commit. The recording entry resolves the scope base to a full commit id, binds the current `HEAD`, and refuses a base that is not an ancestor of it, so a stored record cannot name a candidate other than the one under review. The bound values come from the `verified <head> <fingerprint>` line that `npm run check` prints and stores in the proof, and the independent report must stay outside the checkout or be ignored because the fingerprint covers untracked non-ignored paths.

## Alternatives considered

**Keep the review as an unpinned transcript.** Recording only that a clean review happened leaves the gate bypassable by editing after the review, by reusing a verdict for another candidate, or by deleting the metadata; the observed clean-then-three-defects sequence is exactly the failure it hides.

**Let the gate pass when no proof or ledger exists.** This preserves the previous behaviour for small or documentation-only changes, but it also preserves the bypass: removing or archiving the metadata becomes a way to commit without any review.

**Store the verdict inside the verification proof.** A single file is simpler, but `npm run check` runs before the review and must not require a verdict to exist; the two records have different producers and lifetimes, so the proof gains a verdict-identity check instead of the verdict's storage.

## Consequences

A clean verdict now binds one candidate and one report hash, so editing after the review invalidates the commit instead of silently passing. The cost is that every commit, including a documentation-only slice, needs a fresh `npm run check` and one complete independent review; the alternative is a gate that any metadata deletion bypasses. The hook cannot judge review quality: it proves that a clean report for these exact bytes was recorded, not that the review was complete, which is why the coverage matrix and the `VERDICT: INCOMPLETE` outcome live in AGENTS.md as review obligations.
