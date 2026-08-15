// Logic moved to the Rust push_target / publish_target_status cores in orca-git:
// the status resolution is driven by both A-bridges (main via napi, relay via
// wasm), and the `remote/branch` display-name formatter is now reached from the
// renderer through src/renderer/src/lib/git-wasm/git-publish-target-status.ts.
// Nothing here was a type or a constant, so this is an import-safe stub.
export {}
