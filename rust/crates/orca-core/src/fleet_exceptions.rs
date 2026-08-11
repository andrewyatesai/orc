//! The fleet exceptions reducer, ported from
//! `src/renderer/src/components/alab/fleet-exceptions.ts` (`docs/reference/app-modes.md` §8.3).
//!
//! Lives in `orca-core` rather than `orca-policy` on purpose. `orca-policy` is
//! the *authority* tier — "may this file be served to a child's browser", "may
//! this caller type into that agent's terminal" — and its worth is that every
//! answer in it is a permission. This module grants nothing and gates nothing:
//! it decides which row a supervisor SEES and in what order, exactly like
//! `quick_open_filter` and `repo_badge_color` next door. Zero deps, no IO.
//!
//! **Collapse happens BEFORE ordering.** Ordering first and de-duplicating after
//! would keep whichever row happened to sort first rather than the most severe
//! one, so a task showing `circuit-broken` could be represented by its earliest
//! `escalation`.
//!
//! **The collapse key is the TASK, not the run.** A run with twelve stuck tasks
//! is twelve rows; collapsing it to one is the regression this module exists to
//! prevent, and the parity corpus pins it.

use core::cmp::Ordering;

/// JS relational order on strings: UTF-16 code units, lexicographic.
///
/// NOT `str`'s own ordering, which is UTF-8 bytes — the two disagree wherever a
/// supplementary-plane character meets U+E000..U+FFFF, because JS ranks it by a
/// leading surrogate (0xD800..) and UTF-8 ranks it by code point.
fn js_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// §8.3's six sources. The kind is the badge, and it is also the severity key.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum FleetExceptionKind {
    Gate,
    Escalation,
    CircuitBroken,
    LifecycleRejected,
    Attention,
    UnansweredAsk,
}

impl FleetExceptionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gate => "gate",
            Self::Escalation => "escalation",
            Self::CircuitBroken => "circuit-broken",
            Self::LifecycleRejected => "lifecycle-rejected",
            Self::Attention => "attention",
            Self::UnansweredAsk => "unanswered-ask",
        }
    }

    /// `None` for anything outside §8.3's six. TS would index `SEVERITY` with it
    /// and get `undefined`, poisoning every comparison into `false` and the sort
    /// comparator into `NaN`; that shape is deliberately not ported, so callers
    /// must reject the row instead of guessing what it ranks as.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "gate" => Some(Self::Gate),
            "escalation" => Some(Self::Escalation),
            "circuit-broken" => Some(Self::CircuitBroken),
            "lifecycle-rejected" => Some(Self::LifecycleRejected),
            "attention" => Some(Self::Attention),
            "unanswered-ask" => Some(Self::UnansweredAsk),
            _ => None,
        }
    }
}

/// Most severe first. `circuit-broken` outranks `escalation` because the breaker
/// means the fleet has STOPPED retrying — nothing further happens without a
/// human — whereas an escalation may still resolve itself on the next attempt.
/// `gate` is highest because it is the one state where a worker is actively
/// blocked on this specific person.
const fn severity(kind: FleetExceptionKind) -> u8 {
    match kind {
        FleetExceptionKind::Gate => 6,
        FleetExceptionKind::CircuitBroken => 5,
        FleetExceptionKind::UnansweredAsk => 4,
        FleetExceptionKind::LifecycleRejected => 3,
        FleetExceptionKind::Escalation => 2,
        FleetExceptionKind::Attention => 1,
    }
}

#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub struct FleetException {
    /// The collapse key. Every source must resolve one, or its rows cannot be
    /// merged with the other five and the task appears twice.
    pub task_id: String,
    pub kind: FleetExceptionKind,
    pub summary: String,
    pub worker_handle: Option<String>,
    /// How many raw rows collapsed into this one — the retry counter a
    /// supervisor reads as "this has failed repeatedly", not "this happened
    /// once".
    pub attempts: i64,
    /// ISO timestamp; the running MAXIMUM across everything that collapsed in,
    /// which is not necessarily the winning row's own timestamp.
    pub at: String,
}

/// One row per task: the most severe kind wins, and `attempts` counts everything
/// that collapsed into it.
///
/// Ordering is severity, then recency. Not recency alone — a circuit-broken task
/// from an hour ago still outranks an escalation from a minute ago, because the
/// older one is the one that will never resolve itself.
///
/// Takes the input by value: the TS copies each row on insert, and consuming the
/// vector reaches the same result without a `Clone` on a heap-bearing type.
pub fn collapse_exceptions_by_task(raw: Vec<FleetException>) -> Vec<FleetException> {
    // A `Vec` scanned linearly, not a hash map: the TS `Map` yields first-seen
    // insertion order, which the stable sort below then relies on for ties.
    let mut collapsed: Vec<FleetException> = Vec::new();

    for exception in raw {
        let Some(existing) = collapsed
            .iter_mut()
            .find(|entry| entry.task_id == exception.task_id)
        else {
            collapsed.push(exception);
            continue;
        };

        // JS `>` exactly — code-unit order, NOT the `localeCompare` the TS sort
        // uses and NOT `str`'s byte order. That the sort disagrees with this
        // merge is the TS's own bug, not one this port introduces.
        let newer = js_order(&exception.at, &existing.at) == Ordering::Greater;
        // Strictly-greater alone would keep the FIRST of two equal-severity
        // rows, so two escalations at 10:00 and 12:00 would leave the task
        // showing 10:00 — and then sorting by that stale timestamp ranks it
        // below fresher, less urgent work. On a tie the newer row wins, because
        // it is the current state of the task.
        let takes_over = severity(exception.kind) > severity(existing.kind)
            || (severity(exception.kind) == severity(existing.kind) && newer);

        // Attempts survive the merge regardless of which row won: the count is
        // about the task, not about the winning row. Saturating because a
        // counter overflowing i64 must not decide whether the queue renders.
        existing.attempts = existing.attempts.saturating_add(exception.attempts);
        if takes_over {
            existing.kind = exception.kind;
            existing.summary = exception.summary;
            existing.worker_handle = exception.worker_handle;
        }
        // Recency survives too, and independently of the winner: a lower-severity
        // but newer row still means the task moved, which is what the sort's
        // tiebreak needs to know.
        if newer {
            existing.at = exception.at;
        }
    }

    // Stable, so tasks tied on both severity and timestamp keep first-seen order
    // — the same guarantee ES2019 gives `Array.prototype.sort`.
    //
    // One order for both the merge and the tiebreak. The TS uses `localeCompare`
    // here and `>` there, so it can rank the same pair of timestamps two ways;
    // the corpus pins that divergence rather than importing ICU to reproduce it.
    collapsed.sort_by(|left, right| {
        severity(right.kind)
            .cmp(&severity(left.kind))
            .then_with(|| js_order(&right.at, &left.at))
    });
    collapsed
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum ExceptionSourceStatus {
    Wired,
    NotYet,
}

impl ExceptionSourceStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wired => "wired",
            Self::NotYet => "not-yet",
        }
    }
}

/// Key order of the TS `EXCEPTION_SOURCE_STATUS` object literal, which is what
/// `Object.keys` returns and therefore the order of [`unwired_exception_sources`].
pub const EXCEPTION_SOURCE_ORDER: [FleetExceptionKind; 6] = [
    FleetExceptionKind::Gate,
    FleetExceptionKind::Escalation,
    FleetExceptionKind::CircuitBroken,
    FleetExceptionKind::Attention,
    FleetExceptionKind::LifecycleRejected,
    FleetExceptionKind::UnansweredAsk,
];

/// Which of §8.3's six sources this build actually reads.
///
/// Stated as data rather than prose so the console can say what it cannot see.
/// A supervisor who believes the queue covers all six, when it covers one, will
/// read an empty queue as "nothing is wrong" — precisely the failure the queue
/// exists to prevent.
pub const fn exception_source_status(kind: FleetExceptionKind) -> ExceptionSourceStatus {
    match kind {
        // Real per-task rows from orchestration.gateList — NOT runList's per-run
        // count, which cannot be decomposed back into the tasks it counted.
        FleetExceptionKind::Gate => ExceptionSourceStatus::Wired,
        FleetExceptionKind::Escalation => ExceptionSourceStatus::Wired,
        FleetExceptionKind::CircuitBroken => ExceptionSourceStatus::Wired,
        // Stale-heartbeat detection: the only thing that can tell a wedged worker
        // from a finished one, since agent-hook status decays a non-done entry
        // to idle.
        FleetExceptionKind::Attention => ExceptionSourceStatus::Wired,
        // Detected by the payload marker the Rust store stamps, not by message
        // type — a rejection is a worker_done/heartbeat that Orca refused.
        FleetExceptionKind::LifecycleRejected => ExceptionSourceStatus::Wired,
        // An unread decision_gate message with no reply on its thread.
        FleetExceptionKind::UnansweredAsk => ExceptionSourceStatus::Wired,
    }
}

pub fn unwired_exception_sources() -> Vec<FleetExceptionKind> {
    EXCEPTION_SOURCE_ORDER
        .into_iter()
        .filter(|kind| exception_source_status(*kind) == ExceptionSourceStatus::NotYet)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exception(task_id: &str, kind: FleetExceptionKind, at: &str) -> FleetException {
        FleetException {
            task_id: task_id.to_string(),
            kind,
            summary: format!("{task_id}@{at}"),
            worker_handle: Some("w1".to_string()),
            attempts: 1,
            at: at.to_string(),
        }
    }

    #[test]
    fn collapses_a_retry_storm_into_one_row_carrying_the_attempt_count() {
        let collapsed = collapse_exceptions_by_task(vec![
            exception("t", FleetExceptionKind::Escalation, "2026-08-07T10:00:00Z"),
            exception("t", FleetExceptionKind::Escalation, "2026-08-07T10:00:03Z"),
            exception("t", FleetExceptionKind::Escalation, "2026-08-07T10:00:06Z"),
            exception("t", FleetExceptionKind::CircuitBroken, "2026-08-07T10:00:09Z"),
        ]);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed.first().map(|row| row.attempts), Some(4));
        assert_eq!(
            collapsed.first().map(|row| row.kind),
            Some(FleetExceptionKind::CircuitBroken)
        );
    }

    #[test]
    fn keeps_tasks_of_one_run_apart() {
        // The regression: collapsing per RUN showed one row for twelve stuck tasks.
        let collapsed = collapse_exceptions_by_task(vec![
            exception("run7-a", FleetExceptionKind::Escalation, "2026-08-07T10:00:00Z"),
            exception("run7-b", FleetExceptionKind::Escalation, "2026-08-07T10:00:00Z"),
            exception("run7-c", FleetExceptionKind::Escalation, "2026-08-07T10:00:00Z"),
        ]);
        assert_eq!(
            collapsed.iter().map(|row| row.task_id.as_str()).collect::<Vec<_>>(),
            vec!["run7-a", "run7-b", "run7-c"]
        );
    }

    #[test]
    fn severity_outranks_recency() {
        let collapsed = collapse_exceptions_by_task(vec![
            exception("new", FleetExceptionKind::Escalation, "2026-08-07T12:00:00Z"),
            exception("old", FleetExceptionKind::CircuitBroken, "2026-08-07T09:00:00Z"),
        ]);
        assert_eq!(
            collapsed.iter().map(|row| row.task_id.as_str()).collect::<Vec<_>>(),
            vec!["old", "new"]
        );
    }

    #[test]
    fn merged_timestamp_is_the_running_max_not_the_winners_own() {
        let collapsed = collapse_exceptions_by_task(vec![
            exception("t", FleetExceptionKind::Escalation, "2026-08-07T09:00:00Z"),
            exception("t", FleetExceptionKind::Gate, "2026-08-07T08:00:00Z"),
        ]);
        let row = collapsed.first();
        assert_eq!(row.map(|r| r.kind), Some(FleetExceptionKind::Gate));
        assert_eq!(row.map(|r| r.at.as_str()), Some("2026-08-07T09:00:00Z"));
    }

    #[test]
    fn all_six_sources_are_wired_so_an_empty_queue_means_all_clear() {
        assert_eq!(unwired_exception_sources(), vec![]);
        assert!(EXCEPTION_SOURCE_ORDER
            .into_iter()
            .all(|kind| exception_source_status(kind) == ExceptionSourceStatus::Wired));
    }

    #[test]
    fn timestamps_merge_in_js_code_unit_order_not_utf8_byte_order() {
        // U+10000 leads with a surrogate (0xD800) in JS so it ranks below U+E000;
        // its UTF-8 bytes (F0 90 ..) rank above (EE 80 ..). Comparing the Rust
        // strings directly kept the astral row and reported the wrong worker.
        let collapsed = collapse_exceptions_by_task(vec![
            exception("t", FleetExceptionKind::Escalation, "10:00\u{10000}"),
            exception("t", FleetExceptionKind::Escalation, "10:00\u{e000}"),
        ]);
        assert_eq!(
            collapsed.first().map(|row| row.at.as_str()),
            Some("10:00\u{e000}")
        );
    }

    #[test]
    fn empty_input_collapses_to_nothing() {
        assert!(collapse_exceptions_by_task(vec![]).is_empty());
    }
}
