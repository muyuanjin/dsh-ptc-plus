# 0037 Keep Tool Hover Previews Passive

## Status

Accepted

## Context

Execution rows occur inside the conversation's scrolling surface. A pointer can
cross a row because content moves beneath it. An interactive hover portal with
its own scrollbar then becomes the wheel target, changing the meaning of a
gesture already being used to browse the conversation. A longer delay alone
does not preserve scrolling once that portal opens.

## Decision

Execution-row hover is a passive quick peek. The plugin owns a compact preview
with bounded recorded source and result excerpts, explicit truncation text and
a hint to expand the row. Neither the preview nor its descendants participate
in pointer hit testing. Its layout uses clipping, not a scroll container. Full
source, result, Copy and Inspect remain in the explicitly expanded row.

`src/client-tool-hover.js` owns the lifecycle. A shared passive wheel/scroll
observer cancels pending and visible previews. Scrolling must be idle before a
fresh pointer movement or entry can start the next dwell; a stationary pointer
does not reopen a preview after scrolling. Keyboard focus is an explicit
request to preview. Escape, blur, pointer departure, expansion, touch and
unmount retain dismissal and original expansion semantics.

Use the platform's manual Popover top layer, with a public React Portal fallback.
Placement measures only the plugin's anchor, pointer and preview. Prefer the
right of the pointer when the current viewport has enough room; otherwise
place above or below the row. Observe live owned-anchor and viewport size changes.
A default-enabled interface setting controls mouse and keyboard preview without
removing explicit row expansion. The plugin does not
inspect or write Host ancestors, cancel scrolling, forward synthetic wheel
events, patch Host packages or add another authority boundary. The interactive
public HoverCard remains available to other consumers; it does not own this
passive tool preview.

## Consequences

Users see a short preview on deliberate hover and browse or copy full content
by expanding the row. Small viewports may clip more preview text or provide
insufficient room for a preview; the complete row remains available. Excerpts
are UI presentation and establish no claim about canonical value completeness,
model knowledge or state retention.

Browser evidence must use real wheel gestures over a scrollable conversation,
including pending preview, visible preview footprint and stationary-pointer
continuation. It must preserve keyboard/touch expansion and complete recorded
content. Theme and viewport checks cover both native Popover and Portal fallback.
