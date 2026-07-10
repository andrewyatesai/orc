# aterm-effects-web vendor

Orca's Matrix Rain loader uses this generated `wasm-bindgen --target web` pair:

- `aterm_effects_web.js`
- `aterm_effects_web_bg.wasm`

Source: aterm commit `4548602e22b9350ad2e573f2820a9dbaccaeae24`.

Rebuild from that aterm checkout:

```sh
cargo build --release --target wasm32-unknown-unknown -p aterm-effects-web
wasm-bindgen --target web --no-typescript \
  --out-dir ../orca/src/renderer/public/vendor/aterm-effects-web \
  --out-name aterm_effects_web \
  target/wasm32-unknown-unknown/release/aterm_effects_web.wasm
```

SHA-256:

```text
083409569018c3801571a47817ec569281ca6a2ac8184ed70e0aba92445e7948  aterm_effects_web.js
40ea19df55ae65422251a8b764287538f0d15959ea7c36c90d6ffbefc6ee2903  aterm_effects_web_bg.wasm
```

The loader validates both modules and fails closed, leaving xterm usable if
either artifact cannot be loaded.
