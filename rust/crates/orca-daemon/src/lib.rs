//! orca-daemon — a pure-Rust replacement for the Node terminal daemon
//! (`src/main/daemon/`). It owns PTYs via `orca-pty`, runs a real `aterm` engine
//! per session via `orca-terminal`, and speaks the existing NDJSON Unix-socket
//! protocol (`src/main/daemon/types.ts`), so the Electron client can drive it
//! unchanged and the napi PTY→engine hop disappears.
//!
//! Exposed as a lib (not just a bin) so integration tests and the differential
//! parity harness can drive `rpc::dispatch_request` against a `registry::Registry`
//! directly. See docs/rust-migration/move-1-orca-daemon-extraction.md.

// The connection logic is transport-generic (see connection::DaemonStream), so it
// compiles on every platform; each `serve` below supplies its own socket type.
pub mod bounded_stream_channel;
pub mod connection;
pub mod pending_output;
pub mod process_query;
pub mod protocol;
pub mod registry;
pub mod resolver_health;
pub mod rpc;
pub mod scrollback_compress;
pub mod session_search;
pub mod shell_ready_barrier;
pub mod stream_coalescing;
#[cfg(unix)]
pub mod termination_signals;
pub mod token;
pub mod utf8_stream_decoder;

#[cfg(any(unix, windows))]
use connection::handle_connection;
#[cfg(any(unix, windows))]
use registry::Registry;
use std::io;
#[cfg(unix)]
use std::os::unix::net::UnixListener;
#[cfg(any(unix, windows))]
use std::sync::Arc;
#[cfg(any(unix, windows))]
use std::thread;

/// How the socket authenticates its clients. An enum, not an `Option<&str>`, so
/// "no authentication at all" has to be spelled out at every call site instead of
/// being the value you get by passing nothing (authority model §8 item 4).
#[derive(Debug, Clone, Copy)]
pub enum SocketAuth<'a> {
    /// The live app: self-generate a token, publish it to this path (0600) for the
    /// client to read, and reject every `hello` whose token doesn't match.
    TokenFile(&'a str),
    /// NO client authentication — every process that can reach the socket is
    /// served as the owner. Parity harness and standalone benches only; the binary
    /// requires an explicit `--insecure-no-token-auth` to reach this.
    Unauthenticated,
}

// Uses `Arc`, which only the two real transports import; the fallback `serve`
// needs neither method.
#[cfg(any(unix, windows))]
impl SocketAuth<'_> {
    /// Mint + publish the token, or `None` for the unauthenticated mode.
    fn provision(&self) -> io::Result<Option<Arc<str>>> {
        match self {
            Self::TokenFile(path) => {
                let generated = token::generate_token()?;
                token::write_token_file(path, &generated)?;
                Ok(Some(Arc::from(generated.as_str())))
            }
            Self::Unauthenticated => Ok(None),
        }
    }

    /// Startup-log wording. The unauthenticated case names itself and its
    /// consequence — a log line reading `auth=off` under-reports what is true.
    fn describe(&self) -> &'static str {
        match self {
            Self::TokenFile(_) => "token",
            Self::Unauthenticated => "NONE (--insecure-no-token-auth: any local process may drive this daemon)",
        }
    }
}

/// The peer's effective uid, or `None` when it cannot be determined (the peer
/// already vanished, or this unix has no primitive wired here). macOS/BSD is
/// `getpeereid(2)`; Linux is `SO_PEERCRED`.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    nix::unistd::getpeereid(stream.as_raw_fd())
        .ok()
        .map(|(uid, _gid)| uid.as_raw())
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    nix::sys::socket::getsockopt(stream.as_raw_fd(), nix::sys::socket::sockopt::PeerCredentials)
        .ok()
        .map(|cred| cred.uid())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "linux"))))]
fn peer_uid(_stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    None
}

/// Fail closed: only our own uid is allowed, and a peer we could not identify is
/// refused rather than trusted.
#[cfg(unix)]
fn peer_uid_allowed(peer: Option<u32>, our: u32) -> bool {
    matches!(peer, Some(uid) if uid == our)
}

/// The accept-time gate: hand back the stream only if its peer is `our_uid`,
/// else log the denial and drop it (the peer sees EOF). Takes `our_uid` as an
/// argument so a test can stage the mismatch a real cross-uid connect cannot.
#[cfg(unix)]
fn accept_from_our_uid(
    stream: std::os::unix::net::UnixStream,
    our_uid: u32,
) -> Option<std::os::unix::net::UnixStream> {
    let peer = peer_uid(&stream);
    if peer_uid_allowed(peer, our_uid) {
        return Some(stream);
    }
    eprintln!("orca-daemon: refused connection (peer uid {peer:?} != {our_uid})");
    None
}

/// Bind the socket so it is owner-only FROM CREATION. `bind(2)` applies the
/// process umask to the new socket inode, so under a hostile umask the endpoint
/// exists world-accessible until a later chmod lands (measured on macOS: umask
/// 000 → an 0777 socket) — and that chmod is a path re-resolution, the step
/// `token::write_token_file` deliberately removed. Masking the bind closes the
/// window instead of narrowing it.
///
/// `fchmod` on the listener fd is NOT the alternative it looks like — the fd names
/// the socket object, not the directory entry `bind` created. Measured on macOS:
/// it returns EINVAL and the path stays at its creation mode. The umask is the
/// only mechanism that applies at creation.
///
/// Windows has no umask and no mode bits: the named-pipe path relies on the
/// pipe's default DACL (see the `#[cfg(windows)]` `serve` below).
#[cfg(unix)]
fn bind_private_socket(socket_path: &str) -> io::Result<UnixListener> {
    use nix::sys::stat::{umask, Mode};
    use std::os::unix::fs::PermissionsExt;
    // 0o177 clears every group/other bit (and owner-execute) → the socket lands 0600.
    // umask is process-global, so restore it immediately: PTY children inherit it,
    // and serve() binds before any worker thread exists.
    let prior = umask(Mode::from_bits_truncate(0o177));
    let bound = UnixListener::bind(socket_path);
    umask(prior);
    let listener = bound?;
    // The umask is the mechanism; this is the proof. Reading a mode back can never
    // be turned into a write, and applying the umask to a socket file is not POSIX
    // guaranteed — a platform that ignores it must fail loudly here rather than
    // serve an endpoint anyone can reach.
    let mode = std::fs::metadata(socket_path)?.permissions().mode();
    if !mode_is_owner_only(mode) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "orca-daemon: refusing to serve {socket_path}: socket bound with mode {:o}",
                mode & 0o7777
            ),
        ));
    }
    Ok(listener)
}

/// Owner-only for a socket: NO group/other bit. `connect(2)` needs the write bit,
/// but a readable/searchable socket is state no one else should see either.
#[cfg(unix)]
fn mode_is_owner_only(mode: u32) -> bool {
    mode & 0o077 == 0
}

/// Bind the Unix socket at `socket_path` and serve connections forever. Each
/// accepted socket is handled on its own thread (a control RPC socket or an event
/// stream socket, distinguished by its `hello` role). A stale socket file from a
/// crashed prior daemon is cleared first; the socket is created 0o600 (owner-only,
/// parity with the Node daemon) — see `bind_private_socket`.
#[cfg(unix)]
pub fn serve(socket_path: &str, auth: SocketAuth<'_>) -> io::Result<()> {
    let _ = std::fs::remove_file(socket_path);
    let listener = bind_private_socket(socket_path)?;

    let expected_token = auth.provision()?;

    eprintln!(
        "orca-daemon listening at {socket_path} (protocol v{}, auth={})",
        protocol::PROTOCOL_VERSION,
        auth.describe()
    );
    let registry = Arc::new(Registry::new());
    registry.set_socket_path(socket_path);
    // Why: logout/shutdown SIGTERMs the detached daemon; without this, PTY children ignoring SIGHUP orphan (#7936).
    termination_signals::install(registry.clone());
    let our_uid = nix::unistd::geteuid().as_raw();
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                // The uid IS the daemon's boundary (authority model §7): the socket
                // mode already says owner-only, but a mode is not a check, and a
                // socket inherited or relocated into a shared dir would have none.
                let Some(stream) = accept_from_our_uid(stream, our_uid) else {
                    continue;
                };
                let registry = registry.clone();
                let expected = expected_token.clone();
                thread::spawn(move || handle_connection(stream, registry, expected));
            }
            Err(e) => eprintln!("orca-daemon: accept error: {e}"),
        }
    }
    Ok(())
}

/// Windows transport: the client dials the exact pipe path the spawner passes us
/// (`\\?\pipe\orca-terminal-host-v…`), so this mirrors the unix `serve` with a
/// named-pipe listener instead of a `UnixListener`. The unsafe winapi FFI is
/// isolated in `orca-winpipe` so this crate stays `unsafe_code = "forbid"`. Each
/// accepted pipe instance is handled on its own thread via the shared,
/// transport-generic `handle_connection`.
///
/// Cross-compile-verified for x86_64-pc-windows (lib + tests); the wire protocol,
/// handshake, and threading model are identical to the unix path. End-to-end
/// runtime on a real Windows host has not yet been exercised.
///
/// No peer-uid gate here, and none is possible in the unix shape: Windows has no
/// `getpeereid`/`SO_PEERCRED` for pipes. The equivalent is the pipe's own security
/// descriptor — `CreateNamedPipeW` is called with a NULL SD (orca-winpipe), so the
/// object manager applies the creating token's default DACL (owner + SYSTEM) and
/// refuses another user's `CreateFile` before the daemon ever accepts. That is an
/// ACL, checked by the kernel, rather than a credential we read: it is enforcement
/// at the same boundary, not the same mechanism. A stricter version (an explicit
/// owner-only SD, or `ImpersonateNamedPipeClient` + token-SID compare at accept)
/// needs new unsafe FFI in orca-winpipe — authority model §10 item 10.
#[cfg(windows)]
pub fn serve(socket_path: &str, auth: SocketAuth<'_>) -> io::Result<()> {
    // bind() pre-creates the first pipe instance, and accept() pre-arms the next
    // one on every connection — so a dialing client practically never sees
    // ERROR_PIPE_BUSY (the JS clients retry the residual window).
    let mut listener = orca_winpipe::NamedPipeListener::bind(socket_path)?;

    let expected_token = auth.provision()?;

    eprintln!(
        "orca-daemon listening at {socket_path} (protocol v{}, auth={})",
        protocol::PROTOCOL_VERSION,
        auth.describe()
    );
    let registry = Arc::new(Registry::new());
    registry.set_socket_path(socket_path);
    loop {
        match listener.accept() {
            Ok(stream) => {
                let registry = registry.clone();
                let expected = expected_token.clone();
                thread::spawn(move || handle_connection(stream, registry, expected));
            }
            Err(e) => eprintln!("orca-daemon: accept error: {e}"),
        }
    }
}

/// Fallback for any other platform: no socket transport. Signature matches the
/// real `serve` so `main.rs` calls it unchanged.
#[cfg(not(any(unix, windows)))]
pub fn serve(socket_path: &str, _auth: SocketAuth<'_>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("orca-daemon socket transport is not implemented on this platform (socket {socket_path})"),
    ))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    mod peer_gate {
        use super::super::{accept_from_our_uid, peer_uid, peer_uid_allowed};
        use std::os::unix::net::{UnixListener, UnixStream};

        fn our_uid() -> u32 {
            nix::unistd::geteuid().as_raw()
        }

        /// A connected pair over a real socket, exactly what the accept loop judges.
        fn connected_pair() -> (UnixStream, UnixStream) {
            use std::sync::atomic::{AtomicU32, Ordering};
            static N: AtomicU32 = AtomicU32::new(0);
            let path = format!(
                "{}/orca-daemon-peergate-{}-{}.sock",
                std::env::temp_dir().display(),
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            );
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).expect("bind");
            let client = UnixStream::connect(&path).expect("connect");
            let (server, _) = listener.accept().expect("accept");
            let _ = std::fs::remove_file(&path);
            (server, client)
        }

        #[test]
        fn only_our_own_uid_is_allowed() {
            let our = our_uid();
            assert!(peer_uid_allowed(Some(our), our), "our own uid connects");
            assert!(!peer_uid_allowed(Some(our.wrapping_add(1)), our), "another uid is refused");
            assert!(!peer_uid_allowed(None, our), "an unidentifiable peer is refused, not trusted");
        }

        /// The primitive must be live, not a `None` stub: a stub denies everything,
        /// which would look like a working gate right up until it broke every client.
        #[test]
        fn the_platform_primitive_reports_our_uid_for_a_real_connection() {
            let (server, _client) = connected_pair();
            assert_eq!(peer_uid(&server), Some(our_uid()), "getpeereid/SO_PEERCRED works here");
        }

        #[test]
        fn a_real_same_uid_connection_is_accepted() {
            let (server, _client) = connected_pair();
            assert!(accept_from_our_uid(server, our_uid()).is_some());
        }

        /// The mismatch a same-uid test process cannot otherwise stage: a REAL
        /// connected socket, judged against a uid that is not its peer's.
        #[test]
        fn a_connection_from_another_uid_is_dropped() {
            let (server, _client) = connected_pair();
            let not_us = our_uid().wrapping_add(1);
            assert!(accept_from_our_uid(server, not_us).is_none(), "foreign peer is refused");
        }
    }

    #[cfg(unix)]
    mod socket_privacy {
        use super::super::{bind_private_socket, mode_is_owner_only};
        use nix::sys::stat::{umask, Mode};
        use std::os::unix::fs::PermissionsExt;

        /// AF_UNIX paths are capped near 104 bytes, so this stays directly under
        /// the temp dir rather than in a per-test subdir.
        fn unique_socket_path(tag: &str) -> String {
            use std::sync::atomic::{AtomicU32, Ordering};
            static N: AtomicU32 = AtomicU32::new(0);
            format!(
                "{}/orca-d-{tag}-{}-{}.sock",
                std::env::temp_dir().display(),
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )
        }

        /// What a post-bind chmod cannot give you: with nothing masked, `bind`
        /// creates an 0777 socket anyone may connect to, and a chmod only ends that
        /// exposure — the mode this asserts is the mode the file was BORN with.
        #[test]
        fn the_socket_is_owner_only_under_a_hostile_umask() {
            let path = unique_socket_path("umask");
            let hostile = umask(Mode::empty());
            let bound = bind_private_socket(&path);
            let mode = std::fs::metadata(&path).map(|m| m.permissions().mode() & 0o777);
            // Restore ours, reading back whatever the bind left in force.
            let left_behind = umask(hostile);
            drop(bound);
            let _ = std::fs::remove_file(&path);

            assert_eq!(
                mode.expect("socket exists"),
                0o600,
                "the socket must be private at creation, not one chmod later"
            );
            // PTY children inherit the umask; the mask is ours to borrow, not to keep.
            assert_eq!(left_behind, Mode::empty(), "the prior umask must be restored");
        }

        /// The post-bind proof refuses rather than repairs: a platform whose bind
        /// ignored the umask gets a startup failure, not a reachable socket.
        #[test]
        fn any_group_or_other_bit_disqualifies_a_bound_socket() {
            assert!(mode_is_owner_only(0o140600), "S_IFSOCK | 0600 is ours alone");
            assert!(!mode_is_owner_only(0o140660), "group access");
            assert!(!mode_is_owner_only(0o140604), "other access");
            assert!(!mode_is_owner_only(0o140777));
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn the_unauthenticated_mode_names_itself_in_the_startup_log() {
        use super::SocketAuth;
        assert_eq!(SocketAuth::TokenFile("/tmp/t").describe(), "token");
        let off = SocketAuth::Unauthenticated.describe();
        assert!(off.contains("NONE"), "must not read as a benign `off`: {off}");
        assert!(off.contains("--insecure-no-token-auth"), "names the flag that caused it: {off}");
    }
}
