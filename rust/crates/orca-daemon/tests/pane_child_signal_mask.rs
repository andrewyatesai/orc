//! The daemon blocks SIGTERM/SIGHUP process-wide so its `sigwait` teardown thread
//! is the only reaper (#7936). That mask is inherited across fork AND preserved
//! across execve, so without an explicit reset every pane — and everything a user
//! runs in one — would start with those signals blocked and `kill <pid>` would do
//! nothing. Drives the REAL daemon binary over its socket: read a pane child's own
//! blocked mask, and `kill` a process running inside a pane.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn unique_path(tag: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}/orca-daemon-masktest-{}-{}-{tag}",
        std::env::temp_dir().display(),
        std::process::id(),
        n
    )
}

fn wait_until(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    pred()
}

/// Live means running-or-sleeping: a zombie the daemon has not reaped yet is dead
/// for our purposes, and `kill -0` cannot tell the two apart.
fn pid_alive(pid: u32) -> bool {
    let Ok(out) = Command::new("ps").args(["-p", &pid.to_string(), "-o", "stat="]).output() else {
        return false;
    };
    let state = String::from_utf8_lossy(&out.stdout);
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

fn send_request(stream: &mut UnixStream, reader: &mut BufReader<UnixStream>, req: &str) -> serde_json::Value {
    stream.write_all(req.as_bytes()).expect("write request");
    stream.write_all(b"\n").expect("write newline");
    let mut line = String::new();
    reader.read_line(&mut line).expect("read reply");
    serde_json::from_str(&line).expect("reply is JSON")
}

/// A daemon on its own socket, plus an authenticated control connection.
struct Daemon {
    process: Child,
    socket_path: String,
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Daemon {
    fn start() -> Self {
        let socket_path = unique_path("sock");
        // The auth mode is mandatory now; these tests are about signals, not the token.
        let process = Command::new(env!("CARGO_BIN_EXE_orca-daemon"))
            .args(["--socket", &socket_path, "--insecure-no-token-auth"])
            .spawn()
            .expect("spawn orca-daemon binary");
        assert!(
            wait_until(|| Path::new(&socket_path).exists(), Duration::from_secs(10)),
            "daemon should bind the socket"
        );

        let stream = UnixStream::connect(&socket_path).expect("connect control socket");
        let reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut daemon = Self { process, socket_path, stream, reader };
        let hello = serde_json::json!({
            "type": "hello", "version": orca_daemon::protocol::PROTOCOL_VERSION,
            "token": "masktest", "clientId": "masktest", "role": "control"
        })
        .to_string();
        let reply = daemon.request(&hello);
        assert_eq!(reply["ok"], serde_json::json!(true), "hello accepted");
        daemon
    }

    fn request(&mut self, req: &str) -> serde_json::Value {
        send_request(&mut self.stream, &mut self.reader, req)
    }

    /// Open a pane running `script` under /bin/sh and return the child's pid.
    fn open_pane(&mut self, session_id: &str, script: &str) -> u32 {
        let create = serde_json::json!({
            "id": "c1", "type": "createOrAttach",
            "payload": {
                "sessionId": session_id, "cols": 80, "rows": 24,
                "shellOverride": "/bin/sh",
                "shellArgs": ["-c", script]
            }
        })
        .to_string();
        let created = self.request(&create);
        assert_eq!(created["ok"], serde_json::json!(true), "createOrAttach ok: {created}");
        created["payload"]["pid"].as_u64().expect("new session reports pid") as u32
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = Command::new("kill").args(["-TERM", &self.process.id().to_string()]).status();
        let _ = wait_until(|| matches!(self.process.try_wait(), Ok(Some(_))), Duration::from_secs(10));
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// A shell snippet that writes the running child's own blocked-signal mask to
/// `out` and then idles: `/proc` on Linux, python3 elsewhere (macOS has no
/// `/proc`). `None` when neither probe exists on this host.
fn mask_probe_script(out: &str) -> Option<String> {
    if Path::new("/proc/self/status").exists() {
        return Some(format!("grep '^SigBlk' /proc/self/status > {out}; sleep 30"));
    }
    let python = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"]
        .into_iter()
        .find(|p| Path::new(p).exists())?;
    let probe = format!("{out}.py");
    std::fs::write(
        &probe,
        "import signal\nprint('SIGBLK', sorted(s.name for s in signal.pthread_sigmask(signal.SIG_BLOCK, [])))\n",
    )
    .expect("write probe script");
    Some(format!("{python} {probe} > {out}; sleep 30"))
}

/// True when `report` (either probe's output) shows `signo`/`name` blocked.
fn reports_blocked(report: &str, signo: u32, name: &str) -> bool {
    if let Some(hex) = report.split("SigBlk:").nth(1) {
        let mask = u64::from_str_radix(hex.split_whitespace().next().unwrap_or("0"), 16).unwrap_or(0);
        return mask & (1 << (signo - 1)) != 0;
    }
    report.contains(name)
}

#[test]
fn a_pane_child_does_not_inherit_the_daemons_blocked_signal_mask() {
    let out = unique_path("mask");
    let Some(script) = mask_probe_script(&out) else {
        eprintln!("no /proc or python3 mask probe on this host; skipped");
        return;
    };

    let mut daemon = Daemon::start();
    daemon.open_pane("mask-1", &script);

    assert!(
        wait_until(
            || std::fs::read_to_string(&out).map(|s| !s.trim().is_empty()).unwrap_or(false),
            Duration::from_secs(10)
        ),
        "pane child should report its signal mask"
    );
    let report = std::fs::read_to_string(&out).expect("read mask report");
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(format!("{out}.py"));

    assert!(!reports_blocked(&report, 15, "SIGTERM"), "pane child inherited a blocked SIGTERM: {report:?}");
    assert!(!reports_blocked(&report, 1, "SIGHUP"), "pane child inherited a blocked SIGHUP: {report:?}");
}

#[test]
fn kill_terminates_a_process_running_inside_a_pane() {
    let mut daemon = Daemon::start();
    // `exec` so the pid the daemon reports IS `sleep` — a user's foreground
    // command, with no shell in between to reinterpret the signal.
    let pid = daemon.open_pane("kill-1", "exec sleep 30");
    assert!(wait_until(|| pid_alive(pid), Duration::from_secs(5)), "pane child should be running");

    let killed = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .expect("send SIGTERM")
        .success();
    assert!(killed, "kill -TERM accepted for pane child {pid}");

    assert!(
        wait_until(|| !pid_alive(pid), Duration::from_secs(10)),
        "`kill <pid>` must terminate a process running inside a pane"
    );
}
