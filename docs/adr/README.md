# Architecture Decision Records

This directory records stable design constraints for PTC Plus. An ADR states a decision, the problem it answers, the alternatives it rejected, and the consequences it accepts.

## Rules

- **A new or changed durable decision updates or adds an ADR** in the same change. Record architecture, public or cross-module contracts, persisted or wire formats, and process or tooling choices that a maintainer may reasonably revisit. A difficult or non-trivial implementation of an existing decision does not by itself require an ADR.
- **`## Alternatives considered` is mandatory for a new or changed ADR.** Name each genuine alternative and why it lost, one bold-led paragraph per alternative. A decision recorded without what it beat invites re-litigation. Entries written before this rule may use the shorter `## Alternatives` heading; repair them when they are next touched.
- **Naming.** Files follow `NNNN-kebab-case-title.md`. Keep the number sequence monotonic; never reuse a number.
- **Format.** One physical line per paragraph in new entries, or the entry's own consistent wrapping when it already wraps; the headings and their order are what make an ADR readable:
  - `# <title>` — the decision in one line
  - `## Problem` or `## Context` — the motivation, written to stand without the solution
  - `## Decision` — shipped reality in the present tense; keep it current with what actually shipped
  - bespoke technical sections as needed
  - `## Alternatives considered` — mandatory
  - `## Consequences` — what the trade-off cost and bought; older entries may carry `## Verification` instead or omit it
- **Supersession.** When a later decision replaces an ADR, fold every unique rationale, alternative, and consequence into the current owner and repair inbound links before deleting the old file. Partial supersession keeps both files cross-linked. Git history is not the only copy of rationale.
- **Kept current.** When the code later moves a file, renames a surface, or changes a default, update the owning ADR in the same change (facts only, not the decision itself).

- [0041: Record Cell Execution Directories](0041-record-cell-execution-directories.md) — current execution, captured module sources and historical replay use distinct directory evidence.

- [0042: Persist Provider Availability And Handback](0042-persist-provider-availability-and-handback.md) — accepted-step availability, public persistent release and separately sourced configuration receipts.

- [0043: Compose Capability and Context Policies](0043-compose-capability-and-context-policies.md) — independent availability, disclosure, allocation, collection, recovery and presentation inputs with historical replay generations.

- [0044: Coexist With The Official Persistent REPL](0044-coexist-with-the-official-persistent-repl.md) — forwarded owner release, program format and state retention, plus live-capability ownership selection between PTC Plus and the official persistent REPL.
