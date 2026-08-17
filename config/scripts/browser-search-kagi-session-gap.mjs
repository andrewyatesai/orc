#!/usr/bin/env node
// Executable record of why `buildSearchUrl` is NOT cut over, so the refusal can
// be re-checked instead of re-argued. Exits 0 while the gap is real and prints
// the divergence; exits 1 once the core learns `kagiSessionLink`, which is the
// signal that the refusal is stale and the export can cross.
//
// The gap: TS `buildSearchUrl(query, engine, { kagiSessionLink })` routes Kagi
// searches through the user's private-session link (an account bearer token in
// the URL). The Rust `build_search_url(query, engine)` has no options parameter
// at all — `rust/crates/orca-dispatch/src/modules/browser_search.rs` says so in
// its own header. Crossing would drop every Kagi user back to unauthenticated
// search, and no vector can see it because the corpus only calls the two-arg
// shape.
import { createRequire } from 'node:module'

const ROOT = new URL('../..', import.meta.url).pathname
const require = createRequire(import.meta.url)
const napi = require(`${ROOT}/native/orca-node/orca_node.node`)

const SESSION_LINK = 'https://kagi.com/search?token=SECRET-SESSION-TOKEN'
const QUERY = 'rust ownership'

// The twin's Kagi branch, verbatim in behaviour.
function twinBuildSearchUrl(query, sessionLink) {
  const parsed = new URL(sessionLink)
  parsed.searchParams.delete('q')
  parsed.searchParams.set('token', parsed.searchParams.get('token').trim())
  parsed.hash = ''
  const out = new URL(parsed.toString())
  out.searchParams.set('q', query)
  return out.toString()
}

const twin = twinBuildSearchUrl(QUERY, SESSION_LINK)
const core = JSON.parse(
  napi.orcaDispatch(
    'browser-search',
    'buildSearchUrl',
    JSON.stringify({ query: QUERY, engine: 'kagi', options: { kagiSessionLink: SESSION_LINK } })
  )
)

const coreKeptToken = typeof core === 'string' && core.includes('token=')
console.log(`  twin (session link honoured) -> ${twin}`)
console.log(`  core (options ignored)       -> ${core}`)
console.log(
  coreKeptToken
    ? '\nCORE NOW HONOURS kagiSessionLink — this refusal is stale; re-check and cut buildSearchUrl over.'
    : '\nGap confirmed: the core drops the session token, so a Kagi user would silently lose\n' +
        'their authenticated search. buildSearchUrl stays in TS until the core takes options.'
)
process.exit(coreKeptToken ? 1 : 0)
