//! Per-daemon auth token. The daemon self-generates it, publishes it to the
//! token file (owner-only, 0600) for the Electron client to read, and rejects any
//! `hello` whose token doesn't match — parity with the Node daemon
//! (daemon-server.ts, which likewise generates the token the client then reads).
//!
//! Randomness is 32 bytes of OS entropy: `/dev/urandom` on unix, RtlGenRandom on
//! Windows (via the isolated `orca-winpipe` FFI crate, so this crate stays
//! unsafe-forbidden). The hex encoding is shared.

use std::fs;
use std::io;

/// 32 bytes of OS entropy, lowercase-hex-encoded (64 chars).
pub fn generate_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    fill_entropy(&mut bytes)?;
    let mut hex = String::with_capacity(64);
    for b in bytes {
        // `from_digit` on a nibble (0..=15) never fails.
        hex.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        hex.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    Ok(hex)
}

/// Constant-time equality for the auth token gate. A plain `!=` short-circuits on
/// the first differing byte, leaking a byte-by-byte timing oracle on the 64-char
/// secret — the token gate is the last-line defense where the socket ACL is weaker
/// than the token file's 0600 (the Windows named pipe). Fold every byte into one
/// accumulator so match time depends only on length, never on how many leading
/// bytes agree; `black_box` keeps the optimizer from restoring an early exit.
/// Length is public (fixed 64-char hex), so the length check may return early.
pub fn tokens_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    core::hint::black_box(diff) == 0
}

#[cfg(unix)]
fn fill_entropy(bytes: &mut [u8]) -> io::Result<()> {
    use std::io::Read;
    let mut file = fs::File::open("/dev/urandom")?;
    file.read_exact(bytes)
}

#[cfg(windows)]
fn fill_entropy(bytes: &mut [u8]) -> io::Result<()> {
    orca_winpipe::fill_random(bytes)
}

#[cfg(not(any(unix, windows)))]
fn fill_entropy(_bytes: &mut [u8]) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no OS entropy source on this platform"))
}

/// Create the token file at `path` and refuse to write through anything we did
/// not just create: `O_CREAT|O_EXCL` (never an existing file) plus `O_NOFOLLOW`
/// (never a symlink, even one that races an unlink). `mode` alone is not a
/// control — it applies only when the open CREATES the file, so a plain
/// `create(true)` open of a pre-placed symlink would silently hand every future
/// token to whatever the link points at, or truncate it.
#[cfg(unix)]
fn create_token_file(path: &str) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
}

/// Write `token` to `path` owner-only (0600), replacing any prior token —
/// parity with the Node daemon's `writeFileSync(tokenPath, token, { mode: 0o600 })`
/// but without its two path-following opens. Unlink first (a stale token from our
/// own previous run, or an attacker-planted file/symlink at this path), then
/// create exclusively; the mode is forced through the OPEN fd (`fchmod`), never a
/// second `set_permissions(path, …)` that would re-resolve the name.
#[cfg(unix)]
pub fn write_token_file(path: &str, token: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::remove_file(path);
    let mut file = create_token_file(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(token.as_bytes())?;
    file.flush()
}

/// Windows: the token file lands in the per-user runtime dir (Electron
/// `userData`), which is already ACL'd to the user, so a plain write suffices —
/// the Node daemon's `{ mode: 0o600 }` is likewise a no-op for perm bits on
/// Windows. There is no `O_NOFOLLOW`/`O_EXCL` hardening here because there is no
/// unprivileged symlink to pre-place: creating one needs SeCreateSymbolicLink
/// (Administrator, or Developer Mode), so the pre-emption this guards against on
/// unix is not reachable by a same-user attacker. (A hardened build could still
/// set an explicit owner-only DACL — see the authority model, §10 item 10.)
#[cfg(not(unix))]
pub fn write_token_file(path: &str, token: &str) -> io::Result<()> {
    fs::write(path, token.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::tokens_match;

    #[test]
    fn matches_identical_tokens() {
        let t = "a".repeat(64);
        assert!(tokens_match(&t, &t));
    }

    #[test]
    fn rejects_first_byte_difference() {
        let expected = "0".repeat(64);
        let mut candidate = expected.clone();
        candidate.replace_range(0..1, "1");
        assert!(!tokens_match(&candidate, &expected));
    }

    #[test]
    fn rejects_last_byte_difference() {
        let expected = "0".repeat(64);
        let mut candidate = expected.clone();
        candidate.replace_range(63..64, "1");
        assert!(!tokens_match(&candidate, &expected));
    }

    #[test]
    fn rejects_length_mismatch() {
        assert!(!tokens_match("0".repeat(64).as_str(), "0".repeat(63).as_str()));
        assert!(!tokens_match("", "0"));
    }

    #[test]
    fn empty_matches_empty() {
        assert!(tokens_match("", ""));
    }

    #[cfg(unix)]
    mod token_file {
        use super::super::{create_token_file, write_token_file};
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        // No rand in this crate; pid + a counter is unique enough for a temp path.
        fn unique_path(tag: &str) -> String {
            use std::sync::atomic::{AtomicU32, Ordering};
            static N: AtomicU32 = AtomicU32::new(0);
            format!(
                "{}/orca-daemon-tokenfile-{}-{}-{tag}",
                std::env::temp_dir().display(),
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )
        }

        #[test]
        fn writes_the_token_owner_only() {
            let path = unique_path("plain");
            write_token_file(&path, "deadbeef").expect("write");
            assert_eq!(fs::read_to_string(&path).expect("read"), "deadbeef");
            let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file is owner-only");
            let _ = fs::remove_file(&path);
        }

        /// The attack: a same-uid process pre-points the token path at a file it can
        /// read (or wants truncated). The write must land in a file we created, and
        /// the decoy must be untouched.
        #[test]
        fn a_preplaced_symlink_never_receives_the_token() {
            let decoy = unique_path("decoy");
            let path = unique_path("symlinked");
            fs::write(&decoy, "PRECIOUS").expect("seed decoy");
            std::os::unix::fs::symlink(&decoy, &path).expect("plant symlink");

            write_token_file(&path, "deadbeef").expect("write");

            assert_eq!(
                fs::read_to_string(&decoy).expect("read decoy"),
                "PRECIOUS",
                "the symlink target must not be written or truncated"
            );
            assert!(
                !fs::symlink_metadata(&path).expect("lstat").file_type().is_symlink(),
                "the token path is a real file we created, not the planted link"
            );
            assert_eq!(fs::read_to_string(&path).expect("read token"), "deadbeef");
            let _ = fs::remove_file(&decoy);
            let _ = fs::remove_file(&path);
        }

        /// The unlink in `write_token_file` normally clears the path first, so this
        /// drives the open directly — the O_EXCL|O_NOFOLLOW backstop for a link
        /// re-planted in the unlink→open race window, which cannot be staged in-process.
        #[test]
        fn create_refuses_a_symlink_it_did_not_make() {
            let decoy = unique_path("race-decoy");
            let path = unique_path("race-link");
            fs::write(&decoy, "PRECIOUS").expect("seed decoy");
            std::os::unix::fs::symlink(&decoy, &path).expect("plant symlink");
            assert!(create_token_file(&path).is_err(), "open must not follow the link");
            assert_eq!(fs::read_to_string(&decoy).expect("read decoy"), "PRECIOUS");
            let _ = fs::remove_file(&decoy);
            let _ = fs::remove_file(&path);
        }

        #[test]
        fn create_refuses_an_existing_regular_file() {
            let path = unique_path("exists");
            fs::write(&path, "SOMEONE ELSES").expect("seed");
            assert!(create_token_file(&path).is_err(), "O_EXCL rejects a pre-existing file");
            assert_eq!(fs::read_to_string(&path).expect("read"), "SOMEONE ELSES");
            let _ = fs::remove_file(&path);
        }
    }
}
