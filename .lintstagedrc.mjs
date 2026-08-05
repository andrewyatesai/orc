// lint-staged selects by extension, so generated artifacts that oxlint already
// ignores still reach the command — and oxlint exits non-zero when every file it
// was handed is ignored ("No files found to lint"), which failed the whole commit
// on any aterm pin bump. `oxfmt --write` would additionally rewrite the
// wasm-bindgen glue that .prettierignore keeps byte-exact for the artifact SHA
// pin in check-aterm-artifact-pin.mjs. Filter against oxlint's OWN ignorePatterns
// so the two lists cannot drift apart.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import picomatch from 'picomatch'

const { ignorePatterns = [] } = JSON.parse(
  readFileSync(new URL('.oxlintrc.json', import.meta.url), 'utf8')
)

// A bare directory entry ("rust/vendor") ignores everything under it, the way
// oxlint reads it — picomatch needs that spelled out.
const isIgnored = picomatch(
  ignorePatterns.flatMap((pattern) => [pattern, `${pattern}/**`]),
  { dot: true }
)

const lintable = (files) => files.filter((file) => !isIgnored(relative(process.cwd(), file)))

const quote = (file) => `'${file.replaceAll("'", `'\\''`)}'`

const run = (files, commands) => {
  const kept = lintable(files)
  if (kept.length === 0) {
    return []
  }
  const args = kept.map(quote).join(' ')
  return commands.map((command) => `${command} ${args}`)
}

export default {
  '*.{ts,tsx,js,jsx,mjs,mts,cts}': (files) =>
    run(files, ['oxlint', 'oxlint --config config/oxlint-react-doctor.json', 'oxfmt --write']),
  '*.{json,css}': (files) => run(files, ['oxfmt --write'])
}
