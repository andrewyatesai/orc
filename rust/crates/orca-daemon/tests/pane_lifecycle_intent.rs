//! D4.4 (authority model): a pane teardown must not depend on PTY master EOF.
//! EOF answers "the last holder of the slave closed it", which a backgrounded
//! descendant defers indefinitely — measured with a HUP-immune holder in its own
//! process group: Linux keeps the master open forever, macOS/XNU revokes the
//! controlling tty on session-leader exit and EOFs at once. So the `kill` RPC
//! carries an INTENT seam (`finalize_kill`) beside the pump's EXIT seam
//! (`reap_and_mark_exited`), and the two are idempotent.
//!
//! The sessions here are inserted WITHOUT a pump, which is precisely the state a
//! slave-holding descendant leaves the daemon in: an entry no EOF will ever
//! reach. That models the Linux condition deterministically on any host.

#![cfg(unix)]

use orca_daemon::bounded_stream_channel::stream_channel;
use orca_daemon::pending_output::PendingOutput;
use orca_daemon::registry::{Registry, SessionEngine, SessionEntry};
use orca_daemon::rpc::dispatch_request;
use orca_daemon::stream_coalescing::StreamItem;
use orca_pty::{PtyCommand, PtySession, PtySize};
use orca_terminal::HeadlessTerminal;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Slightly past the daemon's 5s graceful-kill window.
const PAST_KILL_WINDOW: Duration = Duration::from_millis(5_600);

fn dispatch(reg: &Arc<Registry>, client: &str, req: Value) -> Value {
    serde_json::from_str(&dispatch_request(&req, reg, client)).expect("valid JSON")
}

/// A live session with NO pump thread — an entry whose EOF reap can never fire.
fn insert_pumpless(reg: &Arc<Registry>, id: &str, client: &str, script: &str) -> Option<u32> {
    let pty = PtySession::spawn(
        &PtyCommand {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            ..Default::default()
        },
        PtySize { rows: 24, cols: 80 },
    )
    .expect("spawn");
    let pid = pty.process_id();
    reg.insert_session(
        id.to_string(),
        SessionEntry {
            pty,
            client_id: client.to_string(),
            cols: 80,
            rows: 24,
            pid,
            created_at_ms: 0,
            engine: Arc::new(Mutex::new(SessionEngine {
                terminal: HeadlessTerminal::with_scrollback(24, 80, 1000),
                pending: PendingOutput::default(),
            })),
            barrier: None,
            terminating: false,
        },
    );
    pid
}

fn listed(reg: &Arc<Registry>) -> Vec<String> {
    reg.list_sessions()["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn exit_events(rx: &orca_daemon::bounded_stream_channel::StreamReceiver) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(item) = rx.try_recv() {
        if let StreamItem::Event { json } = item {
            out.push(json);
        }
    }
    out
}

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Route 1 + route 3: the user closes a pane whose child keeps the slave alive.
/// The graceful `kill` must finish the teardown itself — remove the entry, kill
/// the child, and tell the client — instead of waiting on an EOF that never comes.
#[test]
fn graceful_kill_finalizes_a_pane_whose_master_never_eofs() {
    let reg = Arc::new(Registry::new());
    let (tx, rx) = stream_channel();
    reg.register_stream("c".to_string(), tx);
    let pid = insert_pumpless(&reg, "s", "c", "trap '' HUP; while :; do sleep 1; done")
        .expect("pid");
    thread::sleep(Duration::from_millis(400));

    let killed = dispatch(&reg, "c", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "s" } }));
    assert_eq!(killed["ok"], json!(true));
    assert_eq!(listed(&reg), vec!["s"], "still live during the graceful window");

    thread::sleep(PAST_KILL_WINDOW);
    assert!(
        listed(&reg).is_empty(),
        "a closed pane must not stay in the map (listed running, still writable, \
         and fenced from reattach) just because no descendant released the slave"
    );
    assert!(!pid_alive(pid), "the HUP-ignoring child is force-killed");
    let events = exit_events(&rx);
    assert_eq!(events.len(), 1, "exactly one exit event: {events:?}");
    assert!(events[0].contains("\"exit\""), "an exit event: {}", events[0]);
}

/// The same pane, closed immediately: `immediate` means gone now, so the entry is
/// out of the map by the time the RPC replies — not whenever EOF happens to land.
#[test]
fn immediate_kill_finalizes_before_it_replies() {
    let reg = Arc::new(Registry::new());
    let (tx, rx) = stream_channel();
    reg.register_stream("c".to_string(), tx);
    let pid = insert_pumpless(&reg, "s", "c", "trap '' HUP; while :; do sleep 1; done")
        .expect("pid");
    thread::sleep(Duration::from_millis(400));

    let killed = dispatch(&reg, "c", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "s", "immediate": true } }));
    assert_eq!(killed["ok"], json!(true));
    assert!(listed(&reg).is_empty(), "immediate kill leaves nothing behind");
    assert!(!pid_alive(pid), "the child is dead when the reply lands");
    assert_eq!(exit_events(&rx).len(), 1, "the client is told exactly once");
}

/// The intent seam is a second `exit` emitter, so it owes subscribers the same
/// fan-out the EOF reap gives them: a read-only mirror must close with the pane.
#[test]
fn a_finalized_pane_closes_its_subscribers_mirrors() {
    let reg = Arc::new(Registry::new());
    let (owner_tx, owner_rx) = stream_channel();
    let (sub_tx, sub_rx) = stream_channel();
    reg.register_stream("owner".to_string(), owner_tx);
    reg.register_stream("follower".to_string(), sub_tx);
    insert_pumpless(&reg, "s", "owner", "trap '' HUP; while :; do sleep 1; done");
    let subscribed = dispatch(&reg, "follower", json!({ "id": "s", "type": "subscribe",
        "payload": { "sessionId": "s" } }));
    assert_eq!(subscribed["ok"], json!(true));

    dispatch(&reg, "owner", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "s", "immediate": true } }));
    assert_eq!(exit_events(&owner_rx).len(), 1, "the owner is told");
    assert_eq!(exit_events(&sub_rx).len(), 1, "the follower's mirror closes too");
}

/// Reattach after the teardown: the fence must LIFT. Before the intent seam a
/// pane whose master never EOF'd kept `terminating` forever, so createOrAttach on
/// that sessionId answered "Session is terminating" for the life of the daemon.
#[test]
fn a_finalized_pane_can_be_recreated_on_the_same_id() {
    let reg = Arc::new(Registry::new());
    let (tx, _rx) = stream_channel();
    reg.register_stream("c".to_string(), tx);
    insert_pumpless(&reg, "s", "c", "trap '' HUP; while :; do sleep 1; done");
    thread::sleep(Duration::from_millis(400));
    dispatch(&reg, "c", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "s", "immediate": true } }));

    let re = dispatch(&reg, "c", json!({ "id": "re", "type": "createOrAttach",
        "payload": { "sessionId": "s", "cols": 80, "rows": 24,
            "shellOverride": "/bin/sh", "shellArgs": ["-c", "sleep 30"] } }));
    assert_eq!(re["ok"], json!(true), "the terminating fence must lift: {re:?}");
    assert_eq!(re["payload"]["isNew"], json!(true), "a fresh pane, not the dead one");
    dispatch(&reg, "c", json!({ "id": "k2", "type": "kill",
        "payload": { "sessionId": "s", "immediate": true } }));
}

/// The other direction — the one that matters more. Closing one pane must never
/// reap a live one, and a finalize that arrives after the id was recreated must
/// leave the fresh pane alone (`terminating` is the fence).
#[test]
fn a_live_pane_is_never_finalized() {
    let reg = Arc::new(Registry::new());
    let (tx, rx) = stream_channel();
    reg.register_stream("c".to_string(), tx);
    let doomed = insert_pumpless(&reg, "doomed", "c", "trap '' HUP; while :; do sleep 1; done");
    let bystander = insert_pumpless(&reg, "bystander", "c", "sleep 30").expect("pid");
    thread::sleep(Duration::from_millis(400));

    dispatch(&reg, "c", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "doomed", "immediate": true } }));
    assert_eq!(listed(&reg), vec!["bystander"], "only the closed pane is torn down");
    assert!(pid_alive(bystander), "the bystander's child is untouched");

    // A late finalize for an id that has since been recreated (fresh entry, not
    // terminating) must be a no-op — this is the "wrong reap kills a live pane" case.
    reg.finalize_kill("bystander", Some(bystander));
    assert_eq!(listed(&reg), vec!["bystander"], "a stray finalize spares a live pane");
    assert!(pid_alive(bystander));
    let events = exit_events(&rx);
    assert_eq!(events.len(), 1, "one exit, for the closed pane only: {events:?}");

    dispatch(&reg, "c", json!({ "id": "k2", "type": "kill",
        "payload": { "sessionId": "bystander", "immediate": true } }));
    let _ = doomed;
}

/// The blocking half of a kill must not run under the registry lock.
/// portable_pty's `kill` SIGHUPs and then polls for up to 250ms before SIGKILL;
/// doing that under the lock froze EVERY session's output routing and every RPC
/// for that long (measured: a concurrent listSessions blocked 213ms).
#[test]
fn killing_one_pane_does_not_freeze_the_others() {
    let reg = Arc::new(Registry::new());
    let (tx, _rx) = stream_channel();
    reg.register_stream("c".to_string(), tx);
    insert_pumpless(&reg, "doomed", "c", "trap '' HUP; while :; do sleep 1; done");
    insert_pumpless(&reg, "bystander", "c", "sleep 30");
    thread::sleep(Duration::from_millis(400));

    let probe_reg = Arc::clone(&reg);
    let probe = thread::spawn(move || {
        let mut worst = Duration::ZERO;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let t = Instant::now();
            let _ = probe_reg.list_sessions(); // takes the registry lock
            worst = worst.max(t.elapsed());
            thread::sleep(Duration::from_millis(2));
        }
        worst
    });
    thread::sleep(Duration::from_millis(200));
    dispatch(&reg, "c", json!({ "id": "k", "type": "kill",
        "payload": { "sessionId": "doomed", "immediate": true } }));
    let worst = probe.join().expect("probe");
    assert!(
        worst < Duration::from_millis(100),
        "the registry lock was held across the child's kill grace period: \
         a concurrent listSessions waited {worst:?}"
    );

    dispatch(&reg, "c", json!({ "id": "k2", "type": "kill",
        "payload": { "sessionId": "bystander", "immediate": true } }));
}
