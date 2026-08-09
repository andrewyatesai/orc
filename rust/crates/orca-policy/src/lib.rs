//! Pure security decisions for the agent fleet and Story World.
//!
//! Ported from `src/main/story-world/play-path-guard.ts` (`decidePlayPath`) and
//! `src/shared/fleet-grant.ts` (`decideFleetGrant`). These are *authority*
//! decisions — "may this file be served to a child's browser", "may this caller
//! type into that agent's terminal" — so they belong where a verifier can reach
//! them rather than where only the tests I wrote can.
//!
//! Pure by construction: no filesystem, no clock, no IO. `realpath` and `now`
//! are resolved by the caller and passed in, which is what makes the containment
//! rule a total function over its inputs and therefore provable.
//!
//! Panic-free on purpose. No indexing, no `unwrap`, no slicing by computed
//! range: every lookup is an iterator or a `get`, so the only obligations these
//! functions raise are the ones that describe the decision itself.

#![forbid(unsafe_code)]

/// Extensions a world may serve. Mirrors the TS `STORY_PLAY_EXTENSIONS`, and is
/// deliberately an allowlist: a world folder legitimately contains `.env`,
/// `.pem` and notes, none of which are part of a game.
pub const STORY_PLAY_EXTENSIONS: &[&str] = &[
    ".html", ".htm", ".js", ".mjs", ".css", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".svg", ".mp3", ".wav", ".ogg", ".woff", ".woff2",
];

/// Reserved Windows device names. `CON.js` and `con` both resolve to the console
/// device, so the check binds on the STEM rather than the whole segment.
pub const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Why a request was refused. Mirrors the TS discriminant so the parity corpus
/// can compare reason-for-reason rather than just allowed/denied — a guard that
/// refuses for the wrong reason is a guard whose next edit will refuse nothing.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum PlayDenial {
    Traversal,
    EscapesRoot,
    NulByte,
    WindowsDevice,
    AlternateDataStream,
    TrailingDotOrSpace,
    ExtensionNotAllowed,
    Unresolvable,
}

impl PlayDenial {
    /// The exact strings the TS side emits, so parity is textual.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Traversal => "traversal",
            Self::EscapesRoot => "escapes-root",
            Self::NulByte => "nul-byte",
            Self::WindowsDevice => "windows-device",
            Self::AlternateDataStream => "alternate-data-stream",
            Self::TrailingDotOrSpace => "trailing-dot-or-space",
            Self::ExtensionNotAllowed => "extension-not-allowed",
            Self::Unresolvable => "unresolvable",
        }
    }
}

/// The lexical half of the containment decision: everything that can be decided
/// from the request string alone, before any syscall.
///
/// Split from the realpath half deliberately. This part is a total function over
/// a `&str` and therefore the part a verifier can say something useful about;
/// the realpath comparison depends on a filesystem and can only ever be checked
/// against an injected oracle.
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum PlayPathVerdict {
    /// Safe so far: the caller must still confirm `realpath` containment.
    NeedsRealpathCheck { relative_path: String },
    Denied(PlayDenial),
}

/// True when a path segment names a Windows device once its extension is
/// stripped. `NUL.js` is still the null device.
#[must_use]
pub fn is_windows_device_segment(segment: &str) -> bool {
    let stem = match segment.split('.').next() {
        Some(stem) => stem,
        None => segment,
    };
    let lowered = stem.to_ascii_lowercase();
    WINDOWS_DEVICE_NAMES.iter().any(|name| *name == lowered)
}

/// True when the path ends in an extension a world may serve.
#[must_use]
pub fn has_allowed_extension(relative_path: &str) -> bool {
    let lowered = relative_path.to_ascii_lowercase();
    STORY_PLAY_EXTENSIONS
        .iter()
        .any(|extension| lowered.ends_with(extension))
}

/// The longest request path a world may ask for.
///
/// Not arbitrary hardening: without it the decoder allocates in proportion to an
/// attacker-controlled string, which is the `[unbounded_allocation]` obligation
/// Trust refutes. No real game asset path is anywhere near this long, so the cap
/// costs nothing and turns an unbounded allocation into a bounded one.
///
/// The TS twin reads this same number out of `parity-corpus.txt`, so the two
/// sides cannot cap at different lengths.
pub const MAX_REQUEST_PATH_BYTES: usize = 4096;

/// Percent-decodes EXACTLY once, panic-free, with `decodeURIComponent`
/// semantics: `None` when the escape is malformed or the decoded bytes are not
/// valid UTF-8, mirroring the `TypeError` that JS throws and the TS guard
/// catches into `unresolvable`.
///
/// Decoding lives inside the core rather than at the caller because the parity
/// corpus proved the alternative ambiguous: with decoding outside, the TS guard
/// (which decodes internally) and this core disagreed about whether
/// `/%2e%2e/secrets.js` was traversal or an inert literal. One decode, in one
/// place, verified — so `%2e%2e` is always traversal and `%252e%252e` is always
/// the literal `%2e%2e`.
///
/// Decoding is done over BYTES, not chars, because `%C3%A9` is one character
/// spelled as two escapes; decoding each escape to its own `char` would produce
/// mojibake where JS produces `é`, and would accept `%FF` where JS refuses it.
///
/// TRUST: no indexing and no slicing. Bytes are consumed through a peekable
/// iterator, so this raises no bounds obligations.
#[must_use]
pub fn decode_once(request_path: &str) -> Option<String> {
    // The query string is not part of the path. TS splits it off before
    // decoding, so `?a=%zz` must not make the path unresolvable.
    let path = match request_path.split('?').next() {
        Some(path) => path,
        None => request_path,
    };

    if path.len() > MAX_REQUEST_PATH_BYTES {
        return None;
    }
    // A CONSTANT capacity, not `path.len()`. The guard above already bounds the
    // input, but `len()` is an absent callee, so a length-derived capacity is
    // uninterpretable to the verifier and reads as unbounded. A constant is
    // provably finite without needing to interpret anything, and the cap is
    // small enough that over-allocating it is free.
    let mut out: Vec<u8> = Vec::with_capacity(MAX_REQUEST_PATH_BYTES);
    let mut bytes = path.bytes().peekable();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            out.push(byte);
            continue;
        }
        let high = bytes.next().and_then(hex_value)?;
        let low = bytes.next().and_then(hex_value)?;
        // Composed with a shift and an OR rather than `high * 16 + low`.
        // Arithmetically identical for nibbles, but it raises NO overflow
        // obligation: `<<` only constrains the shift amount (a constant 4 < 8)
        // and `|` cannot overflow, whereas `*`/`+` oblige the verifier to know
        // `hex_value <= 15` — which it does not, and refutes with a
        // counterexample.
        out.push((high << 4) | low);
    }
    String::from_utf8(out).ok()
}

/// `None` for anything that is not an ASCII hex digit — the malformed-escape
/// signal, kept as its own total function so the decoder stays branch-simple.
#[must_use]
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Decides the lexical half of `decidePlayPath`.
///
/// `request_path` is the RAW request path as it arrives on the wire. It is
/// decoded exactly once, here.
///
/// TRUST: no indexing and no computed slicing — every segment comes from
/// `split`, so this function raises no bounds obligations and its only
/// obligations describe the containment rule itself.
#[must_use]
pub fn decide_play_path_lexical(raw_request_path: &str) -> PlayPathVerdict {
    let request_path = match decode_once(raw_request_path) {
        Some(decoded) => decoded,
        None => return PlayPathVerdict::Denied(PlayDenial::Unresolvable),
    };
    let request_path = request_path.as_str();
    if request_path.contains('\0') {
        return PlayPathVerdict::Denied(PlayDenial::NulByte);
    }

    let mut relative = String::new();
    for segment in request_path.split(['/', '\\']) {
        if segment.is_empty() {
            continue;
        }
        if segment == ".." {
            return PlayPathVerdict::Denied(PlayDenial::Traversal);
        }
        if segment.contains(':') {
            // `game.js::$DATA` reads the default NTFS stream; a named stream
            // reads hidden content entirely.
            return PlayPathVerdict::Denied(PlayDenial::AlternateDataStream);
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            // Windows strips these silently, so `secret.js.` opens `secret.js`.
            return PlayPathVerdict::Denied(PlayDenial::TrailingDotOrSpace);
        }
        if is_windows_device_segment(segment) {
            return PlayPathVerdict::Denied(PlayDenial::WindowsDevice);
        }
        if !relative.is_empty() {
            relative.push('/');
        }
        relative.push_str(segment);
    }

    if !has_allowed_extension(&relative) {
        return PlayPathVerdict::Denied(PlayDenial::ExtensionNotAllowed);
    }
    PlayPathVerdict::NeedsRealpathCheck {
        relative_path: relative,
    }
}

/// Only loopback, and only the port we minted. A `Host` naming anything else
/// means the request reached us through something we do not control.
#[must_use]
pub fn is_allowed_play_host(host: &str, expected_port: u16) -> bool {
    let mut parts = host.rsplitn(2, ':');
    let port = parts.next().unwrap_or_default();
    let name = match parts.next() {
        Some(name) => name,
        // No colon at all: no port to match.
        None => return false,
    };
    if port.parse::<u16>() != Ok(expected_port) {
        return false;
    }
    name == "127.0.0.1" || name == "localhost" || name == "[::1]"
}

/// Why a fleet grant was refused. Mirrors `FleetGrantDenialReason`.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum GrantDenial {
    NoGrantPresented,
    UnknownGrant,
    Revoked,
    Expired,
    WrongGeneration,
    OpNotGranted,
    TargetNotGranted,
    IncarnationChanged,
}

impl GrantDenial {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoGrantPresented => "no-grant-presented",
            Self::UnknownGrant => "unknown-grant",
            Self::Revoked => "revoked",
            Self::Expired => "expired",
            Self::WrongGeneration => "wrong-generation",
            Self::OpNotGranted => "op-not-granted",
            Self::TargetNotGranted => "target-not-granted",
            Self::IncarnationChanged => "incarnation-changed",
        }
    }
}

/// One authorized pane. `incarnation` of `None` is the wildcard, reserved for
/// panes the fleet itself created — never for one the human already had open.
#[cfg_attr(test, derive(Debug, Clone))]
pub struct GrantTarget {
    pub handle: String,
    pub incarnation: Option<String>,
}

/// The grant as stored. `revoked_at`/`expires_at` are caller-supplied instants
/// so this stays clock-free.
#[cfg_attr(test, derive(Debug, Clone))]
pub struct Grant {
    pub generation: u64,
    pub ops: Vec<String>,
    pub targets: Vec<GrantTarget>,
    pub expires_at_ms: Option<u64>,
    pub revoked: bool,
}

/// What the caller is asking to do.
#[cfg_attr(test, derive(Debug, Clone))]
pub struct GrantRequest {
    pub op: String,
    pub handle: String,
    /// `None` means the pane's real process incarnation is unknown, which must
    /// fail closed: while it is unknown a respawn cannot be detected.
    pub incarnation: Option<String>,
    pub current_generation: u64,
    pub now_ms: u64,
}

/// The §6.6 decision.
///
/// Order is load-bearing and is asserted by the tests: identity failures are
/// reported before scope failures, so a revoked grant never reads as "you asked
/// for the wrong pane" — which would invite a re-mint instead of a stop.
#[must_use]
pub fn decide_fleet_grant(grant: Option<&Grant>, request: &GrantRequest) -> Option<GrantDenial> {
    let grant = match grant {
        Some(grant) => grant,
        None => return Some(GrantDenial::UnknownGrant),
    };
    if grant.revoked {
        return Some(GrantDenial::Revoked);
    }
    if let Some(expires_at) = grant.expires_at_ms {
        if request.now_ms >= expires_at {
            return Some(GrantDenial::Expired);
        }
    }
    if grant.generation != request.current_generation {
        return Some(GrantDenial::WrongGeneration);
    }
    if !grant.ops.iter().any(|op| *op == request.op) {
        return Some(GrantDenial::OpNotGranted);
    }
    let target = grant
        .targets
        .iter()
        .find(|target| target.handle == request.handle);
    let target = match target {
        Some(target) => target,
        None => return Some(GrantDenial::TargetNotGranted),
    };
    match (&target.incarnation, &request.incarnation) {
        // Wildcard: a pane the fleet created and still owns.
        (None, _) => None,
        // Pinned target, but the pane's incarnation is unknown: fail closed.
        (Some(_), None) => Some(GrantDenial::IncarnationChanged),
        (Some(pinned), Some(actual)) => {
            if pinned == actual {
                None
            } else {
                Some(GrantDenial::IncarnationChanged)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(request_path: &str) -> bool {
        matches!(
            decide_play_path_lexical(request_path),
            PlayPathVerdict::NeedsRealpathCheck { .. }
        )
    }

    fn denial(request_path: &str) -> Option<PlayDenial> {
        match decide_play_path_lexical(request_path) {
            PlayPathVerdict::Denied(denial) => Some(denial),
            PlayPathVerdict::NeedsRealpathCheck { .. } => None,
        }
    }

    #[test]
    fn serves_the_files_a_game_is_made_of() {
        assert!(allowed("/index.html"));
        assert!(allowed("/game.js"));
        assert!(allowed("/art/cat.png"));
    }

    #[test]
    fn refuses_anything_off_the_extension_allowlist() {
        for path in ["/.env", "/key.pem", "/notes.txt", "/game"] {
            assert_eq!(denial(path), Some(PlayDenial::ExtensionNotAllowed), "{path}");
        }
    }

    #[test]
    fn refuses_traversal() {
        assert_eq!(denial("/../secrets.js"), Some(PlayDenial::Traversal));
        assert_eq!(denial("/art/../../secrets.js"), Some(PlayDenial::Traversal));
        // Backslash is a separator on Windows, so it must split too.
        assert_eq!(denial("\\..\\secrets.js"), Some(PlayDenial::Traversal));
    }

    #[test]
    fn refuses_the_windows_shapes_the_old_sanitizer_missed() {
        assert_eq!(denial("/CON.js"), Some(PlayDenial::WindowsDevice));
        assert_eq!(denial("/nul.js"), Some(PlayDenial::WindowsDevice));
        assert_eq!(denial("/com1.js"), Some(PlayDenial::WindowsDevice));
        assert_eq!(
            denial("/game.js::$DATA"),
            Some(PlayDenial::AlternateDataStream)
        );
        assert_eq!(
            denial("/game.js./"),
            Some(PlayDenial::TrailingDotOrSpace)
        );
    }

    #[test]
    fn refuses_a_nul_byte() {
        assert_eq!(denial("/game.js\0.png"), Some(PlayDenial::NulByte));
    }

    #[test]
    fn decodes_exactly_once() {
        // One decode: `%2e%2e` IS traversal and must be refused...
        assert_eq!(denial("/%2e%2e/secrets.js"), Some(PlayDenial::Traversal));
        // ...and a second decode never happens, so `%252e%252e` stays the
        // literal `%2e%2e`, which is contained and therefore harmless.
        assert!(allowed("/%252e%252e/secrets.js"));
    }

    #[test]
    fn a_malformed_escape_is_refused_rather_than_guessed_at() {
        // decodeURIComponent throws here; the TS guard catches that into
        // `unresolvable`, and guessing at the caller's intent is how a decoder
        // ends up disagreeing with the thing that opens the file.
        assert_eq!(denial("/%zz/game.js"), Some(PlayDenial::Unresolvable));
        assert_eq!(denial("/game%.js"), Some(PlayDenial::Unresolvable));
        // %FF is a well-formed escape for a byte that is not valid UTF-8.
        assert_eq!(denial("/%FF/game.js"), Some(PlayDenial::Unresolvable));
    }

    #[test]
    fn multi_byte_escapes_decode_as_one_character() {
        // %C3%A9 is `é` — two escapes, one char. Decoding per-escape would
        // produce two chars and a filename that does not exist.
        match decide_play_path_lexical("/caf%C3%A9/game.js") {
            PlayPathVerdict::NeedsRealpathCheck { relative_path } => {
                assert_eq!(relative_path, "café/game.js");
            }
            other => panic!("expected a contained path, got {other:?}"),
        }
    }

    #[test]
    fn an_over_long_path_is_refused_rather_than_allocated_for() {
        let long = format!("/{}.js", "a".repeat(MAX_REQUEST_PATH_BYTES));
        assert_eq!(denial(&long), Some(PlayDenial::Unresolvable));
        // One byte under the cap still works, so the bound is the bound.
        let ok = format!("/{}.js", "a".repeat(MAX_REQUEST_PATH_BYTES - 5));
        assert!(allowed(&ok));
    }

    #[test]
    fn the_cap_matches_the_one_the_ts_side_reads() {
        let declared = include_str!("../parity-corpus.txt")
            .lines()
            .find_map(|line| line.trim().strip_prefix("# max-request-path-bytes:"))
            .and_then(|value| value.trim().parse::<usize>().ok());
        assert_eq!(declared, Some(MAX_REQUEST_PATH_BYTES));
    }

    #[test]
    fn the_query_string_is_not_part_of_the_path() {
        assert!(allowed("/game.js?cachebust=%zz"));
    }

    #[test]
    fn host_must_be_loopback_on_the_minted_port() {
        assert!(is_allowed_play_host("127.0.0.1:5123", 5123));
        assert!(is_allowed_play_host("localhost:5123", 5123));
        assert!(!is_allowed_play_host("127.0.0.1:9999", 5123));
        assert!(!is_allowed_play_host("evil.example.com:5123", 5123));
        assert!(!is_allowed_play_host("localhost", 5123));
    }

    fn grant() -> Grant {
        Grant {
            generation: 0,
            ops: vec!["write".to_string()],
            targets: vec![GrantTarget {
                handle: "worker-1".to_string(),
                incarnation: Some("inc_1".to_string()),
            }],
            expires_at_ms: None,
            revoked: false,
        }
    }

    fn request() -> GrantRequest {
        GrantRequest {
            op: "write".to_string(),
            handle: "worker-1".to_string(),
            incarnation: Some("inc_1".to_string()),
            current_generation: 0,
            now_ms: 1_000,
        }
    }

    #[test]
    fn allows_the_op_it_granted_on_the_pane_it_granted() {
        assert_eq!(decide_fleet_grant(Some(&grant()), &request()), None);
    }

    #[test]
    fn refuses_a_caller_presenting_nothing() {
        assert_eq!(
            decide_fleet_grant(None, &request()),
            Some(GrantDenial::UnknownGrant)
        );
    }

    #[test]
    fn reports_identity_failures_before_scope_failures() {
        // A revoked grant asked for the wrong op is REVOKED, not op-not-granted:
        // "unknown/wrong scope" invites a re-mint where "revoked" is a stop.
        let mut revoked = grant();
        revoked.revoked = true;
        let mut wrong_op = request();
        wrong_op.op = "signal".to_string();
        assert_eq!(
            decide_fleet_grant(Some(&revoked), &wrong_op),
            Some(GrantDenial::Revoked)
        );
    }

    #[test]
    fn refuses_after_a_respawn() {
        let mut respawned = request();
        respawned.incarnation = Some("inc_2".to_string());
        assert_eq!(
            decide_fleet_grant(Some(&grant()), &respawned),
            Some(GrantDenial::IncarnationChanged)
        );
    }

    #[test]
    fn fails_closed_when_the_incarnation_is_unknown() {
        // While it is unknown, a respawn cannot be detected — and an unprovable
        // respawn guard is worse than a refusal.
        let mut unknown = request();
        unknown.incarnation = None;
        assert_eq!(
            decide_fleet_grant(Some(&grant()), &unknown),
            Some(GrantDenial::IncarnationChanged)
        );
    }

    #[test]
    fn honors_a_fleet_owned_wildcard() {
        let mut wildcard = grant();
        wildcard.targets = vec![GrantTarget {
            handle: "worker-1".to_string(),
            incarnation: None,
        }];
        let mut any = request();
        any.incarnation = Some("anything".to_string());
        assert_eq!(decide_fleet_grant(Some(&wildcard), &any), None);
    }

    #[test]
    fn expires() {
        let mut expiring = grant();
        expiring.expires_at_ms = Some(500);
        assert_eq!(
            decide_fleet_grant(Some(&expiring), &request()),
            Some(GrantDenial::Expired)
        );
    }

    #[test]
    fn refuses_a_replaced_manager_generation() {
        let mut newer = request();
        newer.current_generation = 1;
        assert_eq!(
            decide_fleet_grant(Some(&grant()), &newer),
            Some(GrantDenial::WrongGeneration)
        );
    }

    /// The shared oracle: the SAME rows the TS suite runs, so a divergence
    /// between the two implementations fails here rather than in production.
    #[test]
    fn matches_shared_parity_corpus() {
        let corpus = include_str!("../parity-corpus.txt");
        let mut checked = 0_usize;
        for line in corpus.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut halves = line.split("=>");
            let input = match halves.next() {
                Some(input) => input.trim(),
                None => continue,
            };
            let expected = match halves.next() {
                Some(expected) => expected.trim(),
                None => continue,
            };
            let actual = match decide_play_path_lexical(input) {
                PlayPathVerdict::NeedsRealpathCheck { .. } => "allowed".to_string(),
                PlayPathVerdict::Denied(denial) => denial.as_str().to_string(),
            };
            assert_eq!(actual, expected, "corpus row: {input}");
            checked += 1;
        }
        assert!(checked >= 12, "corpus too small: {checked}");
    }
}
