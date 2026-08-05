//! The daemon's auth mode is mandatory and explicit (authority model §8 item 4).
//! Before this, `--token` was optional and its absence silently produced a daemon
//! that authenticated nobody — the daemon brokers every Orca terminal, so that
//! must be a startup failure, not a default. Drives the REAL binary's argv path.
//!
//! Unix-only: it asserts the daemon bound its socket, which is the unix transport
//! (the Windows named-pipe path has no file to stat). The argv/exit-code
//! assertions themselves are platform-neutral.
#![cfg(unix)]

use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Generous because the FIRST exec of a freshly built (unsigned) binary on macOS
/// stalls in dyld for tens of seconds while Gatekeeper/XProtect scans it —
/// measured at >60s here. These assertions are about WHETHER the daemon refuses
/// or binds, never how fast, and they poll, so a long ceiling costs nothing.
const DEADLINE: Duration = Duration::from_secs(90);

fn unique_path(tag: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!(
        "{}/orca-daemon-clitest-{}-{}-{tag}",
        std::env::temp_dir().display(),
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// Run the daemon binary expecting it to refuse and exit. Bounded: a regression
/// that makes it SERVE instead would block `output()` forever, and a hanging test
/// reports nothing — so poll for the exit and fail (loudly) on the deadline.
fn run_expecting_exit(args: &[&str]) -> (Option<i32>, String) {
    run_binary_expecting_exit(env!("CARGO_BIN_EXE_orca-daemon"), args)
}

fn run_binary_expecting_exit(program: &str, args: &[&str]) -> (Option<i32>, String) {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run orca-daemon");
    let deadline = Instant::now() + DEADLINE;
    loop {
        match child.try_wait().expect("try_wait") {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("orca-daemon kept running for {args:?}; it must refuse and exit");
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    }
    let out = child.wait_with_output().expect("collect output");
    (out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn wait_for(path: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::path::Path::new(path).exists() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn a_socket_with_no_auth_mode_refuses_to_start() {
    let socket_path = unique_path("noauth-sock");
    let (code, stderr) = run_expecting_exit(&["--socket", &socket_path]);
    assert_eq!(code, Some(2), "usage error, not a silent unauthenticated bind: {stderr}");
    assert!(stderr.contains("--token"), "the message names the mode it wanted: {stderr}");
    assert!(
        !std::path::Path::new(&socket_path).exists(),
        "nothing may listen without an auth mode"
    );
}

/// The positional form is the same trap by another spelling.
#[test]
fn a_bare_positional_socket_with_no_auth_mode_refuses_to_start() {
    let socket_path = unique_path("positional-sock");
    let (code, _stderr) = run_expecting_exit(&[&socket_path]);
    assert_eq!(code, Some(2));
    assert!(!std::path::Path::new(&socket_path).exists());
}

/// An extra flag must not be able to downgrade a launch that asked for a token.
#[test]
fn token_plus_insecure_is_refused() {
    let socket_path = unique_path("both-sock");
    let token_path = unique_path("both-token");
    let (code, stderr) = run_expecting_exit(&[
        "--socket",
        &socket_path,
        "--token",
        &token_path,
        "--insecure-no-token-auth",
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("mutually exclusive"), "{stderr}");
    assert!(!std::path::Path::new(&socket_path).exists());
}

#[test]
fn the_explicit_insecure_flag_starts_an_unauthenticated_daemon() {
    let socket_path = unique_path("insecure-sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_orca-daemon"))
        .args(["--socket", &socket_path, "--insecure-no-token-auth"])
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let bound = wait_for(&socket_path, DEADLINE);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    assert!(bound, "the opt-in flag is the ONLY way to reach the unauthenticated mode");
}

#[test]
fn a_token_launch_publishes_the_token_and_binds() {
    let socket_path = unique_path("tok-sock");
    let token_path = unique_path("tok-token");
    let mut child = Command::new(env!("CARGO_BIN_EXE_orca-daemon"))
        .args(["--socket", &socket_path, "--token", &token_path])
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let bound = wait_for(&socket_path, DEADLINE);
    let published = wait_for(&token_path, DEADLINE);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_file(&token_path);
    assert!(bound && published, "the app's launch shape still works");
}

/// The shipped binary must not be able to serve unauthenticated even if some
/// future spawn site passes the flag. Copy the daemon to where electron-builder
/// puts it (`…/resources/orca-daemon`, what daemon-init.ts resolves from
/// `process.resourcesPath`) so `current_exe()` sees a packaged layout.
#[test]
fn the_insecure_flag_is_refused_from_a_packaged_bundle_layout() {
    let resources = format!("{}/resources", unique_path("bundle"));
    std::fs::create_dir_all(&resources).expect("mkdir resources");
    let packaged = format!("{resources}/orca-daemon");
    std::fs::copy(env!("CARGO_BIN_EXE_orca-daemon"), &packaged).expect("copy daemon");

    let socket_path = unique_path("packaged-sock");
    let (code, stderr) = run_binary_expecting_exit(
        &packaged,
        &["--socket", &socket_path, "--insecure-no-token-auth"],
    );
    let _ = std::fs::remove_dir_all(std::path::Path::new(&resources).parent().expect("parent"));

    assert_eq!(code, Some(2), "packaged must refuse: {stderr}");
    assert!(stderr.contains("packaged app"), "{stderr}");
    assert!(
        !std::path::Path::new(&socket_path).exists(),
        "no unauthenticated socket from a packaged binary"
    );
}

/// The evasion the sibling test above cannot see: macOS does NOT resolve
/// `current_exe()`, so launching the SAME packaged binary through a link whose
/// parent is not `resources` used to read as a dev build and re-open the flag.
#[test]
fn the_insecure_flag_is_refused_through_a_symlink_to_a_packaged_binary() {
    let root = unique_path("symlinked-bundle");
    let resources = format!("{root}/resources");
    std::fs::create_dir_all(&resources).expect("mkdir resources");
    let packaged = format!("{resources}/orca-daemon");
    std::fs::copy(env!("CARGO_BIN_EXE_orca-daemon"), &packaged).expect("copy daemon");
    // The launch path: same inode, innocent-looking parent.
    let elsewhere = format!("{root}/bin");
    std::fs::create_dir_all(&elsewhere).expect("mkdir bin");
    let link = format!("{elsewhere}/orca-daemon");
    std::os::unix::fs::symlink(&packaged, &link).expect("symlink");

    let socket_path = unique_path("symlinked-sock");
    let (code, stderr) =
        run_binary_expecting_exit(&link, &["--socket", &socket_path, "--insecure-no-token-auth"]);
    let _ = std::fs::remove_dir_all(&root);

    assert_eq!(code, Some(2), "a link is not a different binary: {stderr}");
    assert!(stderr.contains("packaged app"), "{stderr}");
    assert!(
        !std::path::Path::new(&socket_path).exists(),
        "no unauthenticated socket from a packaged binary"
    );
}

/// daemon-init.ts passes `--login-session-watch` ahead of the engine-side watch
/// landing; an unknown flag must stay inert and must never be mistaken for the
/// positional socket path.
#[test]
fn an_unknown_flag_is_inert_and_is_not_taken_as_the_socket_path() {
    let socket_path = unique_path("unknown-sock");
    let token_path = unique_path("unknown-token");
    let mut child = Command::new(env!("CARGO_BIN_EXE_orca-daemon"))
        .args([
            "--login-session-watch",
            "--socket",
            &socket_path,
            "--token",
            &token_path,
        ])
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let bound = wait_for(&socket_path, DEADLINE);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_file(&token_path);
    assert!(bound, "the daemon bound the --socket path, not the unknown flag");
}
