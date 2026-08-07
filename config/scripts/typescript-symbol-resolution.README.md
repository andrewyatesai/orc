# `typescript-symbol-resolution` — keep this

**If you are resolving a merge conflict and deciding whether these files matter:
they do. Keep them. They have already been lost three times.**

## Which files

| File | Role |
| --- | --- |
| `typescript-symbol-resolution.mjs` | The façade. Import this; it re-exports the four modules below. Its header is the authoritative contract. |
| `typescript-program-cache.mjs` | tsconfig scans, scoped/full `ts.Program` construction, path normalisation, `uncoveredSourceFiles()`. |
| `typescript-symbol-identity.mjs` | Declaration-identity resolution: aliases, renames, namespaces, type-only erasure. |
| `typescript-module-reference-index.mjs` | The import-graph prefilter and the re-export laundering closure. |
| `typescript-guard-dominance.mjs` | "Does A provably run before B on every path that reaches B." |
| `typescript-call-site-facts.mjs` | Argument literality and constant folding at a call site. |
| `typescript-reexport-fixture-discovery.mjs` | Test-only. Finds real-tree fixtures by scanning, so the tests name no `src/` path. |
| `typescript-symbol-resolution.test.mjs`, `typescript-module-reference-index.test.mjs`, `typescript-guard-dominance.test.mjs` | The evidence. See "How to check it still works". |

## What it is for

It is the shared substrate for source-analysis tooling in `config/scripts` — the
thing a check imports so it can ask a *semantic* question instead of grepping.
Several gate modules in this directory (`credential-write-*`, `rust-dispatch-*`,
`rust-port-*`) import it. It has no dependency on any of them.

## The contract, in one paragraph

A caller asks "what does this identifier resolve to", not "does this text
appear". Identity is **declaration identity**, so `import { a as b }`,
`export { x } from`, `import * as ns`, `ns['x']` and a local shadow all get the
right answer. A reference flagged `isRuntimeValueReference` is a real runtime
door: no `type` hop in the alias chain, value meaning, value position.
`evaluationDominates(A, B) === true` means A runs before B on every path that
reaches B — it is an **under-approximation**, so `false` means "no guarantee
found", never "provably unguarded", and callers fail closed. To stay affordable
it builds a `ts.Program` rooted only at the files that *can* reference the target
module, proved by closing the import graph over identity-preserving re-exports;
that scoping is exact for "every reference to symbol S" and is **not** a
whole-program lint. The explicit non-goals — `eval`, computed global access,
monkey-patched namespaces, value indirection (`const f = seam.write; f()`,
reported separately by `runtimeAliasEscapes`), cross-function dominance — are
listed in the façade header and are the honest boundary of what it can see.

## How to check it still works

```sh
npx vitest run --config config/vitest.config.ts config/scripts/typescript-*.test.mjs
```

The decisive one is `typescript-module-reference-index.test.mjs` →
*"finds exactly the same references as a full-Program walk"*: it runs the cheap
prefiltered query and an exhaustive walk of a full `ts.Program` over the relay
project and asserts the two reference sets are identical. If that goes red, the
cost optimisation is no longer sound and nothing built on it should be trusted.
`typescript-symbol-resolution.test.mjs` replays nine of the ten text-forgery
attacks that defeated earlier regex-based checks; the tenth (a guard call that
does not dominate the operation) is in `typescript-guard-dominance.test.mjs`.

## Why it keeps getting lost

It is uncommitted work that lives in a directory the maintainer's upstream
merges rewrite. Nothing here is generated and nothing here can be regenerated
from another source — recovery has meant replaying agent transcripts by hand.
Committing it is the fix.
