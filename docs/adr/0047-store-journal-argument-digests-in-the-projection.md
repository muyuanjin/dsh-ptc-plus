# Store journal argument digests in the projection

## Status

Accepted.

## Problem

`ptcPlusSessionLog` keeps one settlement cluster per settled cell. The cluster
carries the cell's call event, its normalized result and its publication, and each
of those carries the cell's journal. A journal's call records hold the argument
wire produced by `encodeValue`, which for a cell that writes a file or assembles a
large value is tens of kilobytes — the same order as the cell source itself. At
450 settled cells a single journal copy is about 20 KB per cell, so keeping every
cluster with its journal would put 9 MB back into the checkpoint at 450 cells and
roughly 40 MB at 2000, which is the growth issue #10 fixed.

The retention window exists for that reason. While it removed whole clusters, it
also removed the recovery evidence those clusters held: a cell beyond the window
could only be restored by refolding the session log, and when the log could not
supply it the cell became unavailable. Recovery therefore depended on a cache
setting.

## Decision

A cluster outside the payload window keeps its identity, its observation, its call
entry and its result, and replaces the payload text with digests:

- the call event's `data.arguments` becomes `{ argumentsDigest, argumentsBytes }`;
- the settlement's `call` carries the same digest pair;
- each journal call record replaces `args` with `{ argsDigest, argsBytes }`, and
  keeps `global`, `member`, `ok`, `settle`, `value` and `error`, so status,
  operations, user binding evidence, confirms and completion stay readable;
- a derived record replaces `code` with `{ codeDigest, codeBytes }` and keeps
  `description`, `targetCallSeq` and the rewrite metadata.

A record carries either the text or its digest, never both. Digests are SHA-256
over the same wire bytes the text form holds, and byte counts are canonical
non-negative integers. A mixed checkpoint — recent clusters in text, older ones in
digests — is the normal shape.

## What admission proves

Admission no longer replays the whole log, so it proves the properties the shapes
themselves carry:

- every retained cluster is complete: call entry, observation, result and
  positions agree;
- a cluster that carries digests carries digests on both sides of each relation
  (settlement call and executable entry, publication journal and normalized
  journal), and the digest pair is well formed;
- the interval summary, when present, reproduces its own chain and its range
  matches the clusters it replaces;
- the frontier and selection history agree with the retained positions.

It does not prove that a digested record's digest describes the text the log
holds. That claim is checked where the two sides meet: refolding a dropped or
digested cluster for an edit or for recovery compares the refolded record with the
stored one, and rejects a mismatch.

## Recovery and refolding

Recovery rebuilds bindings from cell sources and journals. When the checkpoint
holds digests, `recoverJournal` repeats the fold with retention disabled on the
same event slice and reads the text from the log. The checkpoint stays bounded;
the log is the authority. The extra fold happens only when a digested cluster is
present.

## What is lost

- Byte-for-byte equality between the checkpoint's payload and the log's payload:
  the checkpoint keeps the digest, not the text.
- A cell whose text cannot be refolded — because the log does not cover that range
  — is unavailable rather than silently different. Consumers report
  `该单元格超出保留窗口，已不可编辑` / `This cell is outside the retention window and
  can no longer be edited`, and the generic `retention-pruned` for any other read.

## Consequences

The checkpoint's size is a function of the window and of the number of clusters,
not of how many bytes the session wrote. Folding a cluster into the interval
summary remains available through the `retentionClusters` configuration, but it is
no longer the only way to bound the checkpoint, so its default can be unlimited.

## Related

- ADR 0032 owns the projection and its admission claim.
- ADR 0045 owns the model-visible prompt text customization.
