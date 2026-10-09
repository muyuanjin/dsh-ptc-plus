# Record Cell Execution Directories

## Problem

DSH's working-directory service owns the current execution directory. The
immutable Session header still identifies the original project. A persistent
kernel that uses only that header sends new relative operations to an obsolete
directory. Resetting the kernel after a change loses continuous computation;
replaying all old cells from the new directory changes their source meaning.

## Decision

The resolved execution request supplies each live cell's directory. The runtime
validates it before preparation and retains the header only as the historical
fallback for hosts without a current-directory request. The kernel's queue
passes each directory to the compiler and worker without replacing the kernel,
bindings or module graph. New isolated computations inherit the requesting
cell's directory. The plugin never changes the Session header, write roots or
DSH directory state.

Journal v11 adds required `executionCwd`, an absolute string or `null`. New
cells record their resolved directory; `null` retains the historical
header/worker fallback when no directory was supplied. Closed v1–v10 inputs
migrate to `null`, preserving their original source base, language and transform.
Missing or malformed v11 directory evidence invalidates historical recovery
under the existing contraction rule. Replay selects each journal's recorded
directory, independently of the current request.

Stable Node wrappers read the worker execution owner's current directory at
the operation. Relative filesystem and path operations, `process.cwd()` and
new child processes follow it; explicit paths/options and already-created
processes retain their own semantics. An immutable `process.cwd` function can
report successive recorded directories without replacing its descriptor.

Each cell's static adapter, dynamic import environment, synthetic `import.meta`
and provided `require` capture that cell's module source base. Retained module
objects and escaped import/require functions keep their bases. Dynamic lexical
environments propagate their captured importer through activation, parameters,
eval, context and object scopes. Native module files continue resolving their
own imports from their actual URL. The shared public Node hook rewrites only
identified adapters, rather than treating every occurrence of a REPL parent
URL as the current cell.

Skill inventory reads the public working-directory service after Host prompt
assembly. Catalog observation and explicit refresh therefore see the current
directory. A directory change does not reallocate the frozen session plan.
Usage statistics retain the original project as their workspace scope.

## Evidence

`test/plugin-durability-recovery.test.js` compares two directories with same-name
files/modules, escaped imports, eval imports, saved require, new child
computations and continuous bindings; a separate cold replay uses a third
current directory. `test/session-journal.test.js` verifies closed predecessor
migration and malformed/missing v11 rejection. Capability tests distinguish
current Skill inventory, frozen plans, explicit refresh and project statistics.
These focused tests do not establish packed Host or Windows compatibility.
