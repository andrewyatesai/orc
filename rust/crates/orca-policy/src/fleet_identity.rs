//! Fleet identity keys: RouteKey, StoreKey and PtyBinding.
//!
//! Ported from `src/shared/fleet-identity/{route-key,claude_store-key,pty-binding}.ts`
//! (§3a of `docs/reference/alab-auto-mode-design.md`). One module because the
//! three types are one decision surface: a binding names a route and a claude_store,
//! and the claude_store answers the only question with teeth — "may this caller mutate
//! this credential right now".
//!
//! These are authority keys, not labels. A RouteKey decides whose subscription
//! is spent; a StoreKey decides which credential files a launch may write; a
//! PtyBinding is the audit answer to "what was this pane spending at the time".
//! Three properties carry that weight and each is easy to port subtly wrong:
//!
//!   1. [`store_keys_overlap`] is OVERLAP, not equality. Two stores sharing ANY
//!      surface conflict; an equality-shaped port lets two rotations run against
//!      an intersecting set of stores and corrupt one credential.
//!   2. [`parse_route_key`] demands a CANONICAL ROUND-TRIP. A value that parses
//!      but does not re-format to the identical string is REJECTED, or two
//!      spellings of one route become two rows under a unique index and one
//!      reservation is claimed twice.
//!   3. [`union_store_keys`] exists because a rotation is a multi-key
//!      transaction: it must lock the union of every claude_store it touches, never one
//!      directory mutex.
//!
//! Panic-free like the rest of the crate: no indexing, no `unwrap`, no slicing
//! by computed range. Splitting is done with `split_once`/`rsplit_once`/`split`,
//! so the only obligations raised describe the key grammar itself.

use crate::hex_value;

// ---------------------------------------------------------------------------
// Percent coding (the `encodeURIComponent` / `decodeURIComponent` pair)
// ---------------------------------------------------------------------------

/// `encodeURIComponent`: keep unreserved `A-Za-z0-9-_.!~*'()`, escape the rest.
///
/// Local to this crate rather than borrowed from `orca-core` because
/// `orca-policy` is deliberately dependency-free — an authority core that pulls
/// a general-purpose crate in gains that crate's whole obligation surface.
///
/// Deliberately UNBOUNDED, unlike `decode_once`'s capped request path: the TS
/// twin has no cap, and a cap the twin does not share is a divergence that only
/// shows up on the one input that matters. These strings are already-stored keys,
/// not attacker-chosen wire paths.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
            continue;
        }
        out.push('%');
        // Shift/mask rather than `byte / 16` and `byte % 16`: identical for a
        // byte, and division obliges the verifier to know the divisor is nonzero.
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0F));
    }
    out
}

/// Uppercase hex, matching `encodeURIComponent`. Total by construction — a match
/// arm per nibble raises no obligation, where `b'0' + nibble` raises two.
#[must_use]
fn hex_digit(nibble: u8) -> char {
    match nibble {
        0 => '0',
        1 => '1',
        2 => '2',
        3 => '3',
        4 => '4',
        5 => '5',
        6 => '6',
        7 => '7',
        8 => '8',
        9 => '9',
        10 => 'A',
        11 => 'B',
        12 => 'C',
        13 => 'D',
        14 => 'E',
        _ => 'F',
    }
}

/// `decodeURIComponent` that FAILS CLOSED: `None` on a malformed escape or on
/// bytes that are not valid UTF-8, mirroring the `URIError` that JS throws and
/// that both TS modules catch into a rejection.
///
/// Decoding is over BYTES, not chars: `%C3%A9` is one character spelled as two
/// escapes, and decoding each escape to its own `char` would produce mojibake
/// where JS produces `é` while accepting `%FF`, which JS refuses.
#[must_use]
pub fn try_decode_uri_component(value: &str) -> Option<String> {
    let mut out: Vec<u8> = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            out.push(byte);
            continue;
        }
        // A truncated escape (`%2`, a trailing `%`) ends the iterator here, which
        // is the same rejection JS makes by throwing.
        let high = bytes.next().and_then(hex_value)?;
        let low = bytes.next().and_then(hex_value)?;
        out.push((high << 4) | low);
    }
    String::from_utf8(out).ok()
}

// ---------------------------------------------------------------------------
// RouteKey — "which subscription am I spending, on which host"
// ---------------------------------------------------------------------------

/// The tagged account is the point: `SystemDefault` is a real, spendable route
/// and is NOT representable in an account-id-keyed map. Never model this as
/// `Option<String>`.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub enum RouteAccount {
    SystemDefault,
    Managed { account_id: String },
}

/// `local | wsl:<distro> | ssh:<host> | runtime:<env>`. `Wsl { distro: None }`
/// is "the default distro" — one spelling, not a second host kind.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub enum RouteHost {
    Local,
    Wsl { distro: Option<String> },
    Ssh { target_id: String },
    Runtime { environment_id: String },
}

#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub struct RouteKey {
    /// The TS twin types this as `TuiAgent`; the key grammar treats it as an
    /// opaque encoded segment, so narrowing it here would only add a way for the
    /// two sides to disagree about an agent name neither of them decides.
    pub provider: String,
    pub account: RouteAccount,
    pub host: RouteHost,
}

const SYSTEM_DEFAULT: &str = "system-default";
const MANAGED_PREFIX: &str = "managed:";

/// JS `String.prototype.trim`'s whitespace set, spelled out.
///
/// NOT `char::is_whitespace`: the Unicode `White_Space` property and JS's
/// `WhiteSpace ∪ LineTerminator` disagree in both directions — Rust includes
/// U+0085 (NEL), JS does not; JS includes U+FEFF (BOM), Rust does not. That gap
/// is load-bearing here, because a distro of `"\u{FEFF}"` trims to blank in TS
/// (so the key re-formats to bare `wsl` and the canonical check REJECTS it)
/// while `is_whitespace` would keep it and accept a second spelling of the
/// default distro.
#[must_use]
fn is_js_whitespace(value: char) -> bool {
    matches!(value,
        '\u{9}'..='\u{D}'
            | '\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}')
}

/// Blank (or absent) is the DEFAULT distro, not a distro whose name is blank.
#[must_use]
fn normalize_distro(distro: Option<&str>) -> Option<String> {
    let trimmed = distro?.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[must_use]
fn format_account(account: &RouteAccount) -> String {
    match account {
        RouteAccount::SystemDefault => SYSTEM_DEFAULT.to_string(),
        RouteAccount::Managed { account_id } => {
            let mut out = String::from(MANAGED_PREFIX);
            out.push_str(&encode_uri_component(account_id));
            out
        }
    }
}

#[must_use]
fn format_host(host: &RouteHost) -> String {
    match host {
        RouteHost::Local => "local".to_string(),
        RouteHost::Wsl { distro } => match normalize_distro(distro.as_deref()) {
            Some(distro) => {
                let mut out = String::from("wsl:");
                out.push_str(&encode_uri_component(&distro));
                out
            }
            None => "wsl".to_string(),
        },
        RouteHost::Ssh { target_id } => {
            let mut out = String::from("ssh:");
            out.push_str(&encode_uri_component(target_id));
            out
        }
        RouteHost::Runtime { environment_id } => {
            let mut out = String::from("runtime:");
            out.push_str(&encode_uri_component(environment_id));
            out
        }
    }
}

/// Stable string form, safe as a SQLite key (`rotation_sagas.target_route_key`).
/// Every variable part is percent-encoded, so the only unescaped `/`, `@` and
/// `:` are this grammar's own separators and parsing is unambiguous.
#[must_use]
pub fn format_route_key(key: &RouteKey) -> String {
    let mut out = encode_uri_component(&key.provider);
    out.push('/');
    out.push_str(&format_account(&key.account));
    out.push('@');
    out.push_str(&format_host(&key.host));
    out
}

#[must_use]
fn parse_account(value: &str) -> Option<RouteAccount> {
    if value == SYSTEM_DEFAULT {
        return Some(RouteAccount::SystemDefault);
    }
    let managed = value.strip_prefix(MANAGED_PREFIX)?;
    if managed.is_empty() {
        return None;
    }
    Some(RouteAccount::Managed {
        account_id: try_decode_uri_component(managed)?,
    })
}

#[must_use]
fn parse_host(value: &str) -> Option<RouteHost> {
    if value == "local" {
        return Some(RouteHost::Local);
    }
    if value == "wsl" {
        return Some(RouteHost::Wsl { distro: None });
    }
    // FIRST colon, remainder kept whole — the TS `split(':')` + `rest.join(':')`.
    // A host with no colon has an empty body and is refused, which is what keeps
    // an unknown bare tag ("moon") from reading as a host kind.
    let (prefix, body) = value.split_once(':')?;
    if body.is_empty() {
        return None;
    }
    match prefix {
        "wsl" => Some(RouteHost::Wsl {
            distro: normalize_distro(Some(&try_decode_uri_component(body)?)),
        }),
        "ssh" => Some(RouteHost::Ssh {
            target_id: try_decode_uri_component(body)?,
        }),
        "runtime" => Some(RouteHost::Runtime {
            environment_id: try_decode_uri_component(body)?,
        }),
        _ => None,
    }
}

/// `None` when the value is not a route key this module issued — never a coerced
/// fallback, because a mis-parsed route names someone else's subscription.
///
/// The final canonical-form check is the load-bearing half: only a string
/// `format_route_key` would itself emit is accepted. Without it
/// `claude/managed:a@b@local` and `claude/managed:a%40b@local` both name one
/// route, so a unique index on `target_route_key` would hold two rows for one
/// subscription and a reservation could be claimed twice.
#[must_use]
pub fn parse_route_key(value: &str) -> Option<RouteKey> {
    // FIRST `/` and LAST `@`, exactly like the TS `indexOf` / `lastIndexOf`. An
    // empty provider or an empty account segment is refused before decoding.
    let (provider_raw, rest) = value.split_once('/')?;
    if provider_raw.is_empty() {
        return None;
    }
    let (account_raw, host_raw) = rest.rsplit_once('@')?;
    if account_raw.is_empty() {
        return None;
    }
    let provider = try_decode_uri_component(provider_raw)?;
    if provider.is_empty() {
        return None;
    }
    let parsed = RouteKey {
        provider,
        account: parse_account(account_raw)?,
        host: parse_host(host_raw)?,
    };
    if format_route_key(&parsed) == value {
        Some(parsed)
    } else {
        None
    }
}

#[must_use]
pub fn route_keys_equal(a: &RouteKey, b: &RouteKey) -> bool {
    format_route_key(a) == format_route_key(b)
}

/// Health may be account-scoped (§3a rule 1) — this is that projection, and it
/// deliberately drops the host so one exhausted subscription is not reported as
/// healthy merely because a different host has not hit it yet.
#[must_use]
pub fn format_route_account_scope(key: &RouteKey) -> String {
    let mut out = encode_uri_component(&key.provider);
    out.push('/');
    out.push_str(&format_account(&key.account));
    out
}

// ---------------------------------------------------------------------------
// StoreKey — "can two live CLIs coexist here"
// ---------------------------------------------------------------------------

/// One mutable credential surface. A launch touches several at once — config
/// dir, auth file, and on darwin BOTH the scoped and the legacy keychain item —
/// which is why a claude_store is a SET of these and not a directory path.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub enum CredentialSurface {
    ConfigDir { path: String },
    AuthFile { path: String },
    KeychainItem { service: String, account: String },
}

/// Opaque by construction: the surface list is private, so the ONLY way to hold
/// a `StoreKey` is [`create_store_key`], and every one in existence is
/// normalized, deduped and ordered. The TS twin gets the same guarantee from a
/// doc comment and `Object.freeze`.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub struct StoreKey {
    surfaces: Vec<CredentialSurface>,
}

impl StoreKey {
    #[must_use]
    pub fn surfaces(&self) -> &[CredentialSurface] {
        &self.surfaces
    }
}

/// Trailing separators are stripped so `/home/u/.claude` and `/home/u/.claude/`
/// are ONE surface. Treating them as disjoint would let a claude_store-scoped drain
/// proceed while a live CLI still holds the claude_store.
///
/// Case is deliberately NOT folded: darwin and Windows are usually
/// case-insensitive and Linux is not, so folding would merge two genuinely
/// distinct Linux stores. Over-merging is the more dangerous direction — it
/// reports a collision that does not exist and stalls a rotation.
#[must_use]
fn normalize_surface_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    // A bare root ("/" or "C:\") trims to empty; keep the original.
    if trimmed.is_empty() {
        path.to_string()
    } else {
        trimmed.to_string()
    }
}

#[must_use]
fn normalize_surface(surface: &CredentialSurface) -> CredentialSurface {
    match surface {
        CredentialSurface::ConfigDir { path } => CredentialSurface::ConfigDir {
            path: normalize_surface_path(path),
        },
        CredentialSurface::AuthFile { path } => CredentialSurface::AuthFile {
            path: normalize_surface_path(path),
        },
        CredentialSurface::KeychainItem { service, account } => CredentialSurface::KeychainItem {
            service: service.clone(),
            account: account.clone(),
        },
    }
}

/// The identity of a surface. Injective over normalized surfaces, which is what
/// lets dedup, ordering and overlap all be decided on this one string.
#[must_use]
fn format_surface(surface: &CredentialSurface) -> String {
    let mut out = String::new();
    match surface {
        CredentialSurface::ConfigDir { path } => {
            out.push_str("config-dir:");
            out.push_str(&encode_uri_component(&normalize_surface_path(path)));
        }
        CredentialSurface::AuthFile { path } => {
            out.push_str("auth-file:");
            out.push_str(&encode_uri_component(&normalize_surface_path(path)));
        }
        CredentialSurface::KeychainItem { service, account } => {
            out.push_str("keychain-item:");
            out.push_str(&encode_uri_component(service));
            out.push(':');
            out.push_str(&encode_uri_component(account));
        }
    }
    out
}

#[must_use]
fn parse_surface(value: &str) -> Option<CredentialSurface> {
    let mut parts = value.split(':');
    let kind = parts.next()?;
    match kind {
        "config-dir" | "auth-file" => {
            let path = parts.next()?;
            // Exactly one body part. `config-dir:a:b` is not a surface this
            // module ever emitted, so it is refused rather than half-read.
            if parts.next().is_some() {
                return None;
            }
            let path = try_decode_uri_component(path)?;
            if kind == "config-dir" {
                Some(CredentialSurface::ConfigDir { path })
            } else {
                Some(CredentialSurface::AuthFile { path })
            }
        }
        "keychain-item" => {
            let service = parts.next()?;
            let account = parts.next()?;
            if parts.next().is_some() {
                return None;
            }
            Some(CredentialSurface::KeychainItem {
                service: try_decode_uri_component(service)?,
                account: try_decode_uri_component(account)?,
            })
        }
        _ => None,
    }
}

/// Sorted + deduped so two launches naming the same surfaces in a different
/// order produce ONE key, and [`format_store_key`] is a usable SQLite column.
///
/// Ordering is by the formatted surface, which is pure ASCII (every variable
/// part is percent-encoded). That matters: Rust orders `String` by UTF-8 bytes
/// and JS orders by UTF-16 code units, and the two disagree above the BMP — but
/// not on ASCII, so both sides sort identically.
#[must_use]
pub fn create_store_key(surfaces: &[CredentialSurface]) -> StoreKey {
    create_store_key_from(surfaces)
}

#[must_use]
fn create_store_key_from<'a>(
    surfaces: impl IntoIterator<Item = &'a CredentialSurface>,
) -> StoreKey {
    let mut entries: Vec<(String, CredentialSurface)> = Vec::new();
    for surface in surfaces {
        let normalized = normalize_surface(surface);
        let formatted = format_surface(&normalized);
        // Insert-if-absent rather than last-wins: `format_surface` is injective
        // over normalized surfaces, so a repeat carries identical content.
        if entries.iter().any(|(key, _)| *key == formatted) {
            continue;
        }
        entries.push((formatted, normalized));
    }
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));
    StoreKey {
        surfaces: entries.into_iter().map(|(_, surface)| surface).collect(),
    }
}

#[must_use]
pub fn format_store_key(key: &StoreKey) -> String {
    let mut out = String::new();
    for surface in &key.surfaces {
        if !out.is_empty() {
            out.push('|');
        }
        out.push_str(&format_surface(surface));
    }
    out
}

/// `None` when the value is not a claude_store key this module issued. The empty string
/// is the EMPTY claude_store, not a parse failure — a launch that touches no credential
/// surface is a real state, and it must collide with nothing.
#[must_use]
pub fn parse_store_key(value: &str) -> Option<StoreKey> {
    if value.is_empty() {
        return Some(create_store_key(&[]));
    }
    let mut surfaces: Vec<CredentialSurface> = Vec::new();
    for part in value.split('|') {
        surfaces.push(parse_surface(part)?);
    }
    Some(create_store_key(&surfaces))
}

#[must_use]
pub fn store_keys_equal(a: &StoreKey, b: &StoreKey) -> bool {
    format_store_key(a) == format_store_key(b)
}

/// The load-bearing predicate: two launches may run concurrently only when they
/// share NO surface.
///
/// Equality is the WRONG test. A partial overlap — same keychain item, different
/// config dir — is still a collision, and reporting it as disjoint is exactly how
/// two live CLIs corrupt one credential.
#[must_use]
pub fn store_keys_overlap(a: &StoreKey, b: &StoreKey) -> bool {
    a.surfaces.iter().any(|left| {
        let left = format_surface(left);
        b.surfaces.iter().any(|right| format_surface(right) == left)
    })
}

/// A rotation is a multi-key transaction (§3a rule 2), so the saga must lock the
/// union of every claude_store it touches — never one directory mutex, which would
/// leave the keychain item it also rewrites unguarded.
#[must_use]
pub fn union_store_keys(keys: &[StoreKey]) -> StoreKey {
    create_store_key_from(keys.iter().flat_map(|key| key.surfaces.iter()))
}

// ---------------------------------------------------------------------------
// PtyBinding — "what is this live process actually using"
// ---------------------------------------------------------------------------

/// The longest incarnation id, in UTF-16 code units — the TS `isPtyIncarnationId`
/// bound, measured the way JS measures a string.
pub const MAX_PTY_INCARNATION_ID_UNITS: usize = 128;

/// Mirrors `isPtyIncarnationId`: non-empty, at most 128 UTF-16 code units.
///
/// `nth` rather than a summed length: it decides the same predicate without an
/// addition to discharge, and it stops reading after the cap instead of walking
/// an arbitrarily long string.
#[must_use]
pub fn is_pty_incarnation_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .encode_utf16()
            .nth(MAX_PTY_INCARNATION_ID_UNITS)
            .is_none()
}

/// Immutable after commit: every field is private and there is no setter, so a
/// rotation cannot be modelled as editing a live pane's binding in place — it
/// ends one binding and commits another. That is what keeps "what was this pane
/// spending at the time" answerable after the fact.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub struct PtyBinding {
    runtime_id: String,
    pty_incarnation_id: String,
    route: RouteKey,
    store: StoreKey,
}

impl PtyBinding {
    #[must_use]
    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }
    #[must_use]
    pub fn pty_incarnation_id(&self) -> &str {
        &self.pty_incarnation_id
    }
    #[must_use]
    pub fn route(&self) -> &RouteKey {
        &self.route
    }
    #[must_use]
    pub fn claude_store(&self) -> &StoreKey {
        &self.store
    }
}

/// Taken BY VALUE on purpose. The TS twin has to deep-copy and `Object.freeze`
/// the route to stop a caller rewriting a committed binding through the object
/// it still holds; a move gives the same guarantee with nothing to get wrong.
pub struct PtyBindingInput {
    pub runtime_id: String,
    pub pty_incarnation_id: String,
    pub route: RouteKey,
    pub store: StoreKey,
}

/// `None` when the launch cannot be described — an unattributed pane must stay
/// unattributed rather than acquire a plausible-looking binding.
#[must_use]
pub fn commit_pty_binding(input: PtyBindingInput) -> Option<PtyBinding> {
    if input.runtime_id.is_empty() || !is_pty_incarnation_id(&input.pty_incarnation_id) {
        return None;
    }
    Some(PtyBinding {
        runtime_id: input.runtime_id,
        pty_incarnation_id: input.pty_incarnation_id,
        route: input.route,
        // No re-normalization: a `StoreKey` cannot exist un-normalized, which is
        // what the TS `createStoreKey([...store.surfaces])` re-run buys there.
        store: input.store,
    })
}

#[must_use]
pub fn pty_bindings_equal(a: &PtyBinding, b: &PtyBinding) -> bool {
    a.runtime_id == b.runtime_id
        && a.pty_incarnation_id == b.pty_incarnation_id
        && route_keys_equal(&a.route, &b.route)
        && store_keys_equal(&a.store, &b.store)
}

/// The persisted form. Lives in main-owned `PersistedState`, never
/// `GlobalSettings` — routing safety state through the generic renderer settings
/// IPC would expose it.
#[cfg_attr(test, derive(Debug, Clone, PartialEq, Eq))]
pub struct SerializedPtyBinding {
    pub runtime_id: String,
    pub pty_incarnation_id: String,
    pub route_key: String,
    pub store_key: String,
}

#[must_use]
pub fn serialize_pty_binding(binding: &PtyBinding) -> SerializedPtyBinding {
    SerializedPtyBinding {
        runtime_id: binding.runtime_id.clone(),
        pty_incarnation_id: binding.pty_incarnation_id.clone(),
        route_key: format_route_key(&binding.route),
        store_key: format_store_key(&binding.store),
    }
}

/// `None` for anything that is not a binding this module wrote.
///
/// Each argument is `None` when the persisted field was absent or not a string —
/// the distinction matters for `store_key`, where an ABSENT field is a rejection
/// but an EMPTY string is the legitimate empty claude_store.
#[must_use]
pub fn deserialize_pty_binding(
    runtime_id: Option<&str>,
    pty_incarnation_id: Option<&str>,
    route_key: Option<&str>,
    store_key: Option<&str>,
) -> Option<PtyBinding> {
    let route = parse_route_key(route_key?)?;
    // Named `store_key_parsed`, not `claude_store`: `claude_store` is an SMT-LIB reserved
    // word, and Trust lowers local bindings into solver constants by their
    // source name — `ay-dpll` panics on the collision (terms.rs `declare_const`,
    // "symbol name 'claude_store' is reserved"), taking the whole test build down.
    let store_key_parsed = parse_store_key(store_key?)?;
    commit_pty_binding(PtyBindingInput {
        runtime_id: runtime_id?.to_string(),
        pty_incarnation_id: pty_incarnation_id.unwrap_or_default().to_string(),
        route,
        store: store_key_parsed,
    })
}

/// A live pane blocks a claude_store-scoped drain; an ended incarnation does not. The
/// caller supplies liveness because only the runtime knows it.
///
/// Borrowed back rather than cloned: the answer is "which of THESE bindings",
/// and a clone would invite treating the copy as a second binding.
#[must_use]
pub fn bindings_blocking_store<'a>(
    bindings: &'a [PtyBinding],
    // `drained_store`, not `claude_store`: see the reserved-word note above.
    drained_store: &StoreKey,
    is_live: impl Fn(&PtyBinding) -> bool,
) -> Vec<&'a PtyBinding> {
    bindings
        .iter()
        .filter(|binding| is_live(binding) && store_keys_overlap(&binding.store, drained_store))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_system_default() -> RouteKey {
        RouteKey {
            provider: "claude".to_string(),
            account: RouteAccount::SystemDefault,
            host: RouteHost::Local,
        }
    }

    fn config_dir(path: &str) -> CredentialSurface {
        CredentialSurface::ConfigDir {
            path: path.to_string(),
        }
    }

    fn keychain(account: &str) -> CredentialSurface {
        CredentialSurface::KeychainItem {
            service: "Claude Code".to_string(),
            account: account.to_string(),
        }
    }

    #[test]
    fn round_trips_the_route_an_account_id_map_cannot_name() {
        let key = local_system_default();
        assert_eq!(format_route_key(&key), "claude/system-default@local");
        assert_eq!(parse_route_key("claude/system-default@local"), Some(key));
    }

    #[test]
    fn round_trips_every_host_and_account_arm() {
        for key in [
            RouteKey {
                provider: "codex".to_string(),
                account: RouteAccount::Managed {
                    account_id: "acct_1".to_string(),
                },
                host: RouteHost::Wsl {
                    distro: Some("Ubuntu".to_string()),
                },
            },
            RouteKey {
                provider: "codex".to_string(),
                account: RouteAccount::SystemDefault,
                host: RouteHost::Wsl { distro: None },
            },
            RouteKey {
                provider: "gemini".to_string(),
                account: RouteAccount::Managed {
                    account_id: "a/b@c".to_string(),
                },
                host: RouteHost::Ssh {
                    target_id: "box:22".to_string(),
                },
            },
            RouteKey {
                provider: "claude".to_string(),
                account: RouteAccount::SystemDefault,
                host: RouteHost::Runtime {
                    environment_id: "env 1".to_string(),
                },
            },
        ] {
            let formatted = format_route_key(&key);
            assert_eq!(
                parse_route_key(&formatted).as_ref(),
                Some(&key),
                "{formatted}"
            );
        }
    }

    #[test]
    fn refuses_a_non_canonical_spelling_of_a_route_it_can_otherwise_read() {
        // Both name accountId "a@b". Accepting the unescaped spelling would put
        // two rows under one unique index and let a reservation be claimed twice.
        assert_eq!(parse_route_key("claude/managed:a@b@local"), None);
        assert_eq!(
            parse_route_key("claude/managed:a%40b@local"),
            Some(RouteKey {
                provider: "claude".to_string(),
                account: RouteAccount::Managed {
                    account_id: "a@b".to_string()
                },
                host: RouteHost::Local,
            })
        );
    }

    #[test]
    fn refuses_the_shapes_that_are_not_routes() {
        for value in [
            "",
            "claude@local",
            "claude/borrowed@local",
            "claude/managed:@local",
            "claude/system-default@moon:1",
            "claude/system-default@ssh:",
            "claude/system-default",
            "%/system-default@local",
            "claude/managed:%zz@local",
            "claude/system-default@ssh:%E0%A4%A",
        ] {
            assert_eq!(parse_route_key(value), None, "{value}");
        }
    }

    #[test]
    fn a_blank_distro_is_the_default_distro_not_a_distro_named_blank() {
        let key = RouteKey {
            provider: "codex".to_string(),
            account: RouteAccount::SystemDefault,
            host: RouteHost::Wsl {
                distro: Some("   ".to_string()),
            },
        };
        assert_eq!(format_route_key(&key), "codex/system-default@wsl");
        // And the encoded blank spelling is not a second route: it parses to the
        // default distro, re-formats to bare `wsl`, and fails the canonical check.
        assert_eq!(parse_route_key("codex/system-default@wsl:%20%20"), None);
        // A BOM is whitespace to JS `trim` but not to Rust `is_whitespace`; the
        // two sides must agree, or Rust accepts a spelling TS rejects.
        assert_eq!(parse_route_key("codex/system-default@wsl:%EF%BB%BF"), None);
    }

    #[test]
    fn separates_two_hosts_spending_one_subscription() {
        assert!(!route_keys_equal(
            &local_system_default(),
            &RouteKey {
                host: RouteHost::Wsl { distro: None },
                ..local_system_default()
            }
        ));
    }

    #[test]
    fn account_scope_drops_the_host_but_not_the_account() {
        let scope = format_route_account_scope(&local_system_default());
        assert_eq!(
            scope,
            format_route_account_scope(&RouteKey {
                host: RouteHost::Ssh {
                    target_id: "box".to_string()
                },
                ..local_system_default()
            })
        );
        assert!(!scope.contains("local"));
        assert_ne!(
            scope,
            format_route_account_scope(&RouteKey {
                account: RouteAccount::Managed {
                    account_id: "acct_1".to_string()
                },
                ..local_system_default()
            })
        );
    }

    #[test]
    fn one_store_has_one_key_whatever_order_it_is_named_in() {
        let auth = CredentialSurface::AuthFile {
            path: "/home/u/.claude/auth.json".to_string(),
        };
        let a = create_store_key(&[
            config_dir("/home/u/.claude"),
            auth.clone(),
            config_dir("/home/u/.claude"),
        ]);
        let b = create_store_key(&[auth, config_dir("/home/u/.claude")]);
        assert_eq!(format_store_key(&a), format_store_key(&b));
        assert_eq!(a.surfaces().len(), 2);
        assert_eq!(parse_store_key(&format_store_key(&a)), Some(a));
    }

    #[test]
    fn a_trailing_separator_is_the_same_directory() {
        let plain = create_store_key(&[config_dir("/home/u/.claude")]);
        let trailing = create_store_key(&[config_dir("/home/u/.claude/")]);
        assert!(store_keys_overlap(&plain, &trailing));
        assert!(store_keys_equal(&plain, &trailing));
        // A bare root stays usable rather than normalizing to nothing.
        assert!(format_store_key(&create_store_key(&[config_dir("/")])).contains("%2F"));
        // Case is not folded: these are two stores on Linux.
        assert!(!store_keys_overlap(
            &plain,
            &create_store_key(&[config_dir("/Home/u/.claude")])
        ));
    }

    #[test]
    fn a_partial_overlap_is_a_collision_because_equality_is_the_wrong_test() {
        // Different config dirs, ONE keychain item. An equality-shaped guard
        // would run these concurrently and corrupt that item.
        let a = create_store_key(&[config_dir("/a"), keychain("acct_1")]);
        let b = create_store_key(&[config_dir("/b"), keychain("acct_1")]);
        assert!(!store_keys_equal(&a, &b));
        assert!(store_keys_overlap(&a, &b));
        // Genuinely disjoint stores still coexist.
        assert!(!store_keys_overlap(
            &a,
            &create_store_key(&[config_dir("/b"), keychain("legacy")])
        ));
        // And the empty claude_store collides with nothing.
        assert!(!store_keys_overlap(&create_store_key(&[]), &a));
    }

    #[test]
    fn the_union_covers_every_store_the_rotation_touches() {
        let union = union_store_keys(&[
            create_store_key(&[config_dir("/home/u/.claude")]),
            create_store_key(&[keychain("legacy")]),
        ]);
        assert!(store_keys_overlap(
            &union,
            &create_store_key(&[config_dir("/home/u/.claude")])
        ));
        assert!(store_keys_overlap(
            &union,
            &create_store_key(&[keychain("legacy")])
        ));
        assert_eq!(union.surfaces().len(), 2);
    }

    #[test]
    fn refuses_the_shapes_that_are_not_stores() {
        for value in [
            "wallet:/x",
            "keychain-item:svc",
            "config-dir:a:b",
            "config-dir:%",
        ] {
            assert_eq!(parse_store_key(value), None, "{value}");
        }
        assert_eq!(parse_store_key(""), Some(create_store_key(&[])));
    }

    fn binding(runtime_id: &str, incarnation: &str, store: StoreKey) -> Option<PtyBinding> {
        commit_pty_binding(PtyBindingInput {
            runtime_id: runtime_id.to_string(),
            pty_incarnation_id: incarnation.to_string(),
            route: local_system_default(),
            store,
        })
    }

    #[test]
    fn refuses_to_attribute_a_pane_it_cannot_name() {
        let claude_store = create_store_key(&[config_dir("/home/u/.claude")]);
        assert!(binding("", "inc_1", create_store_key(&[])).is_none());
        assert!(binding("rt_1", "", create_store_key(&[])).is_none());
        assert!(binding(
            "rt_1",
            &"i".repeat(MAX_PTY_INCARNATION_ID_UNITS),
            claude_store.clone()
        )
        .is_some());
        assert!(binding("rt_1", &"i".repeat(MAX_PTY_INCARNATION_ID_UNITS + 1), claude_store).is_none());
    }

    #[test]
    fn round_trips_through_its_persisted_form() {
        let claude_store = create_store_key(&[config_dir("/home/u/.claude")]);
        let committed = binding("rt_1", "inc_1", claude_store).expect("committed");
        let serialized = serialize_pty_binding(&committed);
        assert_eq!(
            deserialize_pty_binding(
                Some(&serialized.runtime_id),
                Some(&serialized.pty_incarnation_id),
                Some(&serialized.route_key),
                Some(&serialized.store_key),
            ),
            Some(committed)
        );
    }

    #[test]
    fn refuses_a_persisted_row_it_cannot_trust() {
        // An absent claude_store key is a rejection; the EMPTY string is the empty claude_store.
        assert!(deserialize_pty_binding(
            Some("rt_1"),
            Some("i"),
            Some("claude/system-default@local"),
            None
        )
        .is_none());
        assert!(deserialize_pty_binding(
            Some("rt_1"),
            Some("i"),
            Some("claude/system-default@local"),
            Some("")
        )
        .is_some());
        assert!(deserialize_pty_binding(Some("rt_1"), Some("i"), Some("nope"), Some("")).is_none());
        assert!(deserialize_pty_binding(
            Some("rt_1"),
            Some("i"),
            Some("claude/system-default@local"),
            Some("wallet:/x")
        )
        .is_none());
        assert!(deserialize_pty_binding(
            None,
            Some("i"),
            Some("claude/system-default@local"),
            Some("")
        )
        .is_none());
    }

    #[test]
    fn separates_two_incarnations_of_one_pane() {
        let claude_store = create_store_key(&[config_dir("/home/u/.claude")]);
        let first = binding("rt_1", "inc_1", claude_store.clone()).expect("committed");
        let second = binding("rt_1", "inc_2", claude_store).expect("committed");
        assert!(!pty_bindings_equal(&first, &second));
        assert!(pty_bindings_equal(&first, &first.clone()));
    }

    /// One case per conjunct: an equality that ignores any one of them answers
    /// "same binding" for two panes that are not, and a rotation audit then
    /// cannot say which pane spent what.
    #[test]
    fn every_field_separates_two_bindings() {
        let claude_store = create_store_key(&[config_dir("/a")]);
        let base = binding("rt_1", "inc_1", claude_store.clone()).expect("committed");
        let other_store =
            binding("rt_1", "inc_1", create_store_key(&[config_dir("/b")])).expect("committed");
        let other_runtime = binding("rt_2", "inc_1", claude_store.clone()).expect("committed");
        let other_route = commit_pty_binding(PtyBindingInput {
            runtime_id: "rt_1".to_string(),
            pty_incarnation_id: "inc_1".to_string(),
            route: RouteKey {
                account: RouteAccount::Managed {
                    account_id: "acct_1".to_string(),
                },
                ..local_system_default()
            },
            store: claude_store,
        })
        .expect("committed");
        for differing in [&other_store, &other_runtime, &other_route] {
            assert!(!pty_bindings_equal(&base, differing), "{differing:?}");
        }
    }

    #[test]
    fn only_live_panes_that_touch_the_store_block_a_drain() {
        let claude_store = create_store_key(&[config_dir("/home/u/.claude")]);
        let bindings = vec![
            binding("rt_1", "inc_1", claude_store.clone()).expect("committed"),
            binding(
                "rt_1",
                "inc_2",
                create_store_key(&[config_dir("/elsewhere")]),
            )
            .expect("committed"),
        ];
        let blocking = bindings_blocking_store(&bindings, &claude_store, |_| true);
        assert_eq!(blocking.len(), 1);
        assert_eq!(
            blocking.first().map(|b| b.pty_incarnation_id()),
            Some("inc_1")
        );
        // An ended incarnation does not block.
        assert!(bindings_blocking_store(&bindings, &claude_store, |_| false).is_empty());
    }
}
