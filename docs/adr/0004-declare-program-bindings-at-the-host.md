# Declare Program Bindings At The Owner

PTC Plus does not create a private cross-plugin registry or reflective invocation bus. The public execution-seam request surface ([ADR 0028](0028-attach-to-the-host-ptc-execution-seam.md)) has no registry for discovering non-tool program bindings.

If DSH later provides one, capability owners should publish explicit typed contracts, semantic metadata, source references, and binding factories. DSH should own discovery, scope, authority, leasing, dispatch, and settlement. Explicit registration, generated manifests, decorators, or scanning are assembly choices; none replaces those contracts. PTC Plus would consume only bindings already present in the live request.
