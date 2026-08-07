// The one heuristic in this report: deciding whether the bytes a write puts on
// disk are a secret.
//
// There is no sound answer — `writeFileSync(p, x)` is a secret write iff x
// happens to hold a secret, which is a whole-program value question. So this
// module answers a narrower, stated question: **does the write site name a
// secret?** It matches identifier, property, type and string-literal *word
// segments* (camelCase / snake_case / kebab / dotted are all split) against a
// curated vocabulary, on the payload expression, on the destination path
// expression, and one hop back through same-function local initializers.
//
// WHAT THAT MEANS IN PRACTICE
//   caught    writeFileSync(tokenPath, apiToken)
//             writeFileAtomically(join(home, 'auth.json'), contents)
//             writeSecureJsonFile(p, { secretKeyFormat: 'plaintext', secretKeyB64 })
//             write(p, contents) where `const contents = JSON.stringify(creds)`
//   MISSED    a secret carried in a variable named `blob`, written to a path
//             named `data.bin`, produced more than a few hops away
//   FALSE HIT a non-secret whose name contains a vocabulary word (`csrfToken`
//             is a token; `patchFile` is not, because segments are words, not
//             substrings)
//
// Missing a rename-away secret is the accepted cost, and it is why the report
// makes no completeness claim: it names the sites it found, and says nothing
// whatsoever about the ones it did not. Widening the vocabulary only ever adds
// sites to review.

const SECRET_WORDS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'apitoken',
  'auth',
  'authtoken',
  'bearer',
  'cleartext',
  'clientsecret',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'creds',
  'idtoken',
  'jwt',
  'keychain',
  'keypair',
  'oauth',
  'passphrase',
  'passwd',
  'password',
  'pat',
  'pats',
  'plaintext',
  'privatekey',
  'refreshtoken',
  'safestorage',
  'secret',
  'secrets',
  'secretkey',
  'sessiontoken',
  'token',
  'tokens'
])

/** Words that are secret-shaped only as a whole segment pair, e.g. `api`+`key`.
 *  Kept separate so `key` alone (keyboard, keymap, keyBinding) is not a hit. */
const SECRET_BIGRAM_HEADS = new Set([
  'api',
  'access',
  'auth',
  'client',
  'id',
  'refresh',
  'session',
  'private',
  'secret'
])

const SEGMENT_SPLIT = /[^A-Za-z0-9]+/

/** Splits a name into lowercase word segments: `refreshTokenB64` ->
 *  [refresh, token, b64]; `.credentials.json` -> [credentials, json];
 *  `ORCA_ALLOW_PLAINTEXT` -> [orca, allow, plaintext]. */
export function nameSegments(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(SEGMENT_SPLIT)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
}

/** True when any word segment, or any adjacent pair whose head is a qualifier,
 *  is in the vocabulary. Substring matches never count: `path` is not `pat`,
 *  `patchset` is not `pat`, `monkey` is not `key`. */
export function isSecretName(name) {
  const segments = nameSegments(name)
  for (let index = 0; index < segments.length; index += 1) {
    if (SECRET_WORDS.has(segments[index])) {
      return true
    }
    if (index + 1 < segments.length && SECRET_BIGRAM_HEADS.has(segments[index])) {
      if (SECRET_WORDS.has(segments[index] + segments[index + 1])) {
        return true
      }
    }
  }
  return false
}

/** The vocabulary words a name contributes, for gate messages. */
export function secretWordsIn(name) {
  const segments = nameSegments(name)
  const hits = []
  for (let index = 0; index < segments.length; index += 1) {
    if (SECRET_WORDS.has(segments[index])) {
      hits.push(segments[index])
    }
    if (index + 1 < segments.length && SECRET_BIGRAM_HEADS.has(segments[index])) {
      const joined = segments[index] + segments[index + 1]
      if (SECRET_WORDS.has(joined)) {
        hits.push(joined)
      }
    }
  }
  return [...new Set(hits)]
}

export const VOCABULARY_SIZE = SECRET_WORDS.size
