//! The accept-time peer-uid gate (authority model §8 item 1) end to end: with the
//! token gate deliberately out of the way, a connection from our OWN uid still
//! completes the handshake — i.e. the gate refuses foreign peers without also
//! refusing the app.
//!
//! The refusal half cannot be staged here (a test process cannot become another
//! user); it is covered against a real connected socket by the `peer_gate` unit
//! tests in lib.rs, which judge the same gate against a uid that is not the
//! peer's. What stays unexercised anywhere is a genuine cross-uid connect.
#![cfg(unix)]

use orca_daemon::{serve, SocketAuth};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn a_connection_from_our_own_uid_is_accepted() {
    let socket_path = format!(
        "{}/orca-daemon-peeruid-{}.sock",
        std::env::temp_dir().display(),
        std::process::id()
    );
    let sp = socket_path.clone();
    // serve() blocks forever; the process exiting tears this thread down.
    thread::spawn(move || {
        let _ = serve(&sp, SocketAuth::Unauthenticated);
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::path::Path::new(&socket_path).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = UnixStream::connect(&socket_path).expect("same-uid connect must be served");
    let hello = format!(
        "{}\n",
        serde_json::json!({
            "type": "hello", "version": orca_daemon::protocol::PROTOCOL_VERSION,
            "token": "unused", "clientId": "peer-test", "role": "control"
        })
    );
    stream.write_all(hello.as_bytes()).expect("write hello");
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).expect("the gate must not drop us");
    let reply: serde_json::Value = serde_json::from_str(&line).expect("json");
    assert_eq!(reply["ok"], serde_json::json!(true), "our own uid is served: {line}");
    let _ = std::fs::remove_file(&socket_path);
}
