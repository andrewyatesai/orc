// `looksLikeSearchQuery` on the Rust `orca_core::browser_search` core: does an
// address-bar input mean "search for this" or "navigate to this"?
//
// Reaches main via napi (`normalizeBrowserNavigationUrl` in `browser-url.ts`
// runs there for `will-attach-webview` / `will-navigate` validation) and the
// renderer via wasm (the address bar's suggestion list, plus the same
// normaliser). Mobile does not reach it.
//
// PRE-READY CONTRACT — `parity`. Neither answer can double as "could not ask":
// `true` sends the input to a search engine and `false` navigates to it, so a
// degraded default is a wrong navigation either way — and on the main-process
// path this feeds a security decision about what a webview may load. The
// fallback is the deleted body over the same regex.
//
// FIDELITY was probed against BOTH shipped cores over 31 inputs (15 answering
// true, 16 false, so the corpus can see a mistake in either direction): 31/31
// equal. The cases that matter are the whitespace ones, because the twin's
// `[^\s]+` is JS `\s` and the core's is Rust's — the two disagree about U+FEFF,
// which JS counts as whitespace and Rust does not. `'foo﻿bar'`,
// `'﻿example.com'` and `'example.com﻿'` are in the corpus for that
// reason and agree, but they agree by luck of the branch order rather than by
// the regexes matching, which is why they are pinned as vectors rather than
// reasoned about.
//
// `buildSearchUrl`, this module's other export, is NOT cut over: the Rust
// `build_search_url` takes no options, so crossing it would drop the Kagi
// private-session link and downgrade those users to unauthenticated search.
// `config/scripts/browser-search-kagi-session-gap.mjs` demonstrates it and
// exits 1 once the core learns the option.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'

// Why: bare words like "react hooks" should trigger a search, but inputs that
// look like domain names ("example.com", "foo.bar/path") should navigate
// directly. A single-word input containing a dot with a valid TLD-like suffix
// is treated as a URL attempt, not a search query.
const LOOKS_LIKE_URL_PATTERN = /^[^\s]+\.[a-z]{2,}(\/.*)?$/i

/** The deleted twin's body, verbatim. */
function legacyLooksLikeSearchQuery(input: string): boolean {
  if (input.includes(' ')) {
    return true
  }
  if (LOOKS_LIKE_URL_PATTERN.test(input)) {
    return false
  }
  if (input.includes('.') || input.includes(':')) {
    return false
  }
  return true
}

/** True when the address-bar input should be searched for rather than visited. */
export function looksLikeSearchQuery(input: string): boolean {
  try {
    const answer = tryOrcaDispatch('browser-search', 'looksLikeSearchQuery', input, {
      root: 'input'
    })
    // Unambiguous: the bound arm always answers a boolean, so `null` is only
    // ever "no binding installed".
    return answer === null ? legacyLooksLikeSearchQuery(input) : (answer as boolean)
  } catch (error) {
    // An unpaired surrogate cannot cross the codec. The twin answered those
    // without encoding anything, so this is its answer, not a degrade.
    if (error instanceof DispatchPayloadError) {
      return legacyLooksLikeSearchQuery(input)
    }
    throw error
  }
}
