# Prove a settlement against the record it published

## Status

Accepted (0.5.3).

## Problem

Recovery reads a journal record as evidence for the bindings its cell declared, and the record is the only account of its own cell. Nothing inside it distinguishes "this is what happened" from "this is what someone wrote afterwards".

0.5.2 already checks two things against each other: `completion.error.message` is rendered from the first diagnostic, so a completion that no longer renders from its diagnostic is refused, and `dshPtcPlusDiagnosticWording.digest` covers the facts those diagnostics state. Together they show why internal consistency is not enough. Edit a diagnostic and re-render the completion and the record is consistent again; and the completion's kind and value, and the cell's status, have no second statement anywhere in the record.

## Decision

A settlement leaves a digest of its own statement at publication, and the fold recomputes it before treating the record as evidence:

- `dshPtcPlusSettlementProof = { version, recordedMessage }`, where `recordedMessage` covers the status, the completion (kind, `hasValue`, the value digest, the error kind and message) and the facts each diagnostic states.
- `help` and `source` stay out of it because they are presentation: a historical record may be read through an older generation's help wording, and a caret position is re-derived when the diagnostic is rendered.
- A mismatch means the cell cannot prove its bindings. It establishes a contraction point (`PTC-R002`) beside every other damaged-metadata case. It is not a throw and not a retry: the refusal is the fold's terminal state.
- A record without the field predates this proof and keeps the 0.5.2 evidence rules. Migration is by absence, and the journal schema version does not change, because the proof is a sibling key rather than a journal field.

Alongside it, the Host's `isError` on the same `tool/result` event is a copy this plugin cannot recompute: it comes from what the tool returned, not from the journal. When it is present, the fold requires

```text
isError === (status === "discarded" || completion.kind === "throw")
```

which is the relation a nested edit already proves before it publishes a derived settlement. An editor who repairs the proof from their own edited journal therefore still has to agree with the Host's copy of the outcome.

## What the proof does not claim

- It is not an unforgeable boundary. Someone who rewrites both the facts and the proof is equivalent to a re-publication; what the proof establishes is that the record was not partially rewritten.
- The plugin does not own the Host's model-visible text, so it does not compare against it. That text is a projection this plugin cannot reproduce, and treating it as evidence would call a presentation difference tampering, a far more common event than the damage the proof guards against.
- `dshPtcPlusDiagnosticWording` remains the reading path for records that carry it; a new publication writes one proof rather than two names for one relation.

## Alternatives considered

- **Compare against the retained model-visible message text.** Rejected: the plugin cannot recompute the Host's projection, so a renderer or locale change would read as tampering, and every failing cell in a host that projects differently would lose its bindings.
- **Bump the journal schema version and migrate old records.** Rejected: absence already carries the same information without rewriting historical metadata, and a version bump would make every pre-0.5.3 record unreadable to a generation that has no better evidence to offer.
- **Keep only the diagnostic wording digest and add a separate completion digest.** Rejected: two digests over one settlement state the same relation twice, and the fold would have to decide which of them wins when they disagree.
- **Reject a mismatched record by throwing from the fold.** Rejected: a throw turns every retry into the same throw, which is the loop that hung an earlier attempt. The fold registers an unavailable result instead.

## Consequences

- An edited record no longer proves its cell's bindings. The fold contracts at that cell, the model reads `PTC-R002` naming the skipped cell, and the source stays in the session log.
- Both publication paths write the proof: `withJournal` for a `run_code` settlement and the derived edit settlement's metadata.
- Session logs need no migration: old records lack the field, new records carry it, and the reader branches on its presence.
- The `isError` agreement only applies where the Host records it. A log without that copy keeps the weaker evidence rather than inventing a claim.

## Related

- ADR 0025 owns logical binding identity and language generations.
- [durability-design.md](../durability-design.md) §「Completion 校验」 describes how the fold uses the proof.
