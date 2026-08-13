//! Self-reporting field reads: which input keys did the module actually consume?
//!
//! Every module reads its input through `serde_json::Value::get`, which cannot
//! tell "the caller misspelled this key" from "the caller legitimately omitted
//! it" — both are `None`, and every module maps `None` to a documented default.
//! So `{"droppablesessions":40}` returned the NO-ARG keep-tail (524288) instead
//! of the 40-session answer (65536): confident, wrong, and nothing logged. That
//! is not a regression and not a Rust bug — the TS twin behaves identically and
//! parity passes because they agree — it is an inherited property of a boundary
//! whose input is an untyped `Value`. It starts to matter at cutover, when a shim
//! author's typo buys a plausible wrong answer instead of an error.
//!
//! DERIVING THE LEGAL KEY SET STATICALLY DOES NOT WORK HERE, and this was
//! measured, not assumed: 234 distinct literal keys appear across the 84 module
//! files, but 24 of those files reach fields through an accessor taking
//! `key: &str` (`policy::string_at(input, "incarnation")`, `task_query`'s
//! `str_field` closure), so the literal never appears inside a `.get("…")`. A
//! scanner would omit those keys and REJECT LEGITIMATE INPUT across roughly a
//! third of the corpus — a false rejection in production, which is strictly
//! worse than the silent default it would replace.
//!
//! So the module reports its own reads instead of being guessed at. `field()`
//! records the key it was asked for — including when the value is ABSENT, which
//! is precisely the hazard — and `json_entry` diffs that against the keys the
//! caller supplied.
//!
//! SOUND BY CONSTRUCTION: recording is off until `json_entry` arms it, and a
//! module that has not adopted `field()` records nothing, which reads as
//! "unchecked", never as "every key is unknown". Coverage grows one module at a
//! time, at cutover, and nothing regresses on day one.
//!
//! THE ONE ADOPTION RULE: a module that reads ANY field through `field()` must
//! read EVERY field through it. Mixing `field()` with a raw `input.get("other")`
//! would report `other` as unread and false-reject a valid payload. Adoption is
//! per module and all-or-nothing.
//!
//! TWO SHAPES THAT CANNOT SATISFY THAT RULE — do NOT adopt these, because the
//! diff is against `field()` calls that actually EXECUTED, not against the keys
//! a module could read:
//!
//!   * CONDITIONAL READS. If a key is only read on some branch
//!     (`if mode == "a" { field(input, "aOnly") }`), a valid payload supplying
//!     `aOnly` while taking the other branch reports it unread and is rejected.
//!     Read such keys unconditionally and discard the value, or stay unadopted.
//!   * ITERATING MODULES. A module that consumes the whole object by walking it
//!     (`for (k, v) in obj`) has no key names to hand `field()`, so every key
//!     looks unread. There is no correct adoption for this shape.
//!
//! Both fail toward rejecting valid input, which is worse than the silent
//! default this check replaces. When in doubt, leave the module unadopted: an
//! unchecked module is exactly as safe as it was before this existed.

use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct ConsumedKeys {
    armed: Cell<bool>,
    keys: RefCell<Vec<&'static str>>,
}

thread_local! {
    static CONSUMED: ConsumedKeys = ConsumedKeys::default();
}

/// Read `key` from a module input, recording the ask so the entry can tell a
/// misspelled key from an absent one.
///
/// Records the key even when the field is missing: an unanswered ask is exactly
/// how a typo looks from inside the module.
pub fn field<'a>(input: &'a Value, key: &'static str) -> Option<&'a Value> {
    CONSUMED.with(|consumed| {
        if consumed.armed.get() {
            consumed.keys.borrow_mut().push(key);
        }
    });
    input.get(key)
}

/// Arms recording for exactly one dispatch; disarming is a `Drop` so a panicking
/// module cannot leave a live recorder to poison the next call.
pub(crate) struct Recording;

/// Begin recording. Clears rather than reallocates, so steady-state dispatch does
/// no allocation once the vector has reached its (tiny) high-water mark.
pub(crate) fn arm() -> Recording {
    CONSUMED.with(|consumed| {
        consumed.keys.borrow_mut().clear();
        consumed.armed.set(true);
    });
    Recording
}

impl Drop for Recording {
    fn drop(&mut self) {
        CONSUMED.with(|consumed| consumed.armed.set(false));
    }
}

impl Recording {
    /// Keys the caller supplied that no `field()` read asked for.
    ///
    /// Empty when nothing was recorded — an unadopted module is UNCHECKED, never
    /// "every key is unknown". That fail-open is what makes incremental adoption
    /// safe.
    pub(crate) fn unread_keys(&self, supplied: &Map<String, Value>) -> Vec<String> {
        CONSUMED.with(|consumed| {
            let consumed = consumed.keys.borrow();
            if consumed.is_empty() {
                return Vec::new();
            }
            supplied
                .keys()
                .filter(|key| !consumed.contains(&key.as_str()))
                .cloned()
                .collect()
        })
    }

    /// The keys the module did read, in ask order, for the error message.
    pub(crate) fn consumed_keys(&self) -> Vec<&'static str> {
        CONSUMED.with(|consumed| {
            let mut keys = consumed.keys.borrow().clone();
            keys.dedup();
            keys
        })
    }

    /// The consumed key closest to `unknown`, when one is close enough to name.
    ///
    /// Compared lowercased, so the common wrong-casing (`droppablesessions`)
    /// lands at distance 0 and is always the suggestion.
    pub(crate) fn nearest_consumed(&self, unknown: &str) -> Option<&'static str> {
        let target = unknown.to_lowercase();
        self.consumed_keys()
            .into_iter()
            .map(|key| (edit_distance(&target, &key.to_lowercase()), key))
            .filter(|(distance, key)| *distance <= (key.chars().count() / 3).max(1))
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, key)| key)
    }
}

/// Levenshtein distance, two-row. Only ever runs on the rejection path, so the
/// quadratic shape is irrelevant.
fn edit_distance(a: &str, b: &str) -> usize {
    let b_chars: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    let mut curr = vec![0usize; b_chars.len() + 1];
    for (i, a_char) in a.chars().enumerate() {
        curr[0] = i + 1;
        for (j, b_char) in b_chars.iter().enumerate() {
            let substitute = prev[j] + usize::from(a_char != *b_char);
            curr[j + 1] = substitute.min(prev[j + 1] + 1).min(curr[j] + 1);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_chars.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(json: &str) -> Value {
        serde_json::from_str(json).expect("test input is JSON")
    }

    #[test]
    fn unadopted_module_records_nothing_and_is_unchecked() {
        let input = object(r#"{"anything":1,"atAll":2}"#);
        let recording = arm();
        // No `field()` call: this is what all 82 unadopted modules look like.
        assert!(recording
            .unread_keys(input.as_object().expect("object"))
            .is_empty());
    }

    #[test]
    fn a_read_key_is_not_reported_unread() {
        let input = object(r#"{"droppableSessions":40}"#);
        let recording = arm();
        assert_eq!(field(&input, "droppableSessions"), Some(&json_number(40)));
        assert!(recording
            .unread_keys(input.as_object().expect("object"))
            .is_empty());
    }

    #[test]
    fn a_supplied_but_unread_key_is_reported() {
        let input = object(r#"{"droppablesessions":40}"#);
        let recording = arm();
        // The module asks for the correctly-cased key and gets nothing; the ask is
        // still recorded, which is what exposes the typo.
        assert_eq!(field(&input, "droppableSessions"), None);
        assert_eq!(
            recording.unread_keys(input.as_object().expect("object")),
            vec!["droppablesessions".to_string()]
        );
        assert_eq!(
            recording.nearest_consumed("droppablesessions"),
            Some("droppableSessions")
        );
    }

    #[test]
    fn a_far_away_key_gets_no_suggestion() {
        let input = object(r#"{"totallyUnrelated":1}"#);
        let recording = arm();
        let _ = field(&input, "droppableSessions");
        assert_eq!(recording.nearest_consumed("totallyUnrelated"), None);
    }

    #[test]
    fn recording_is_off_until_armed() {
        // The parity harness calls `dispatch` directly and never arms; reads there
        // must not accumulate in the thread-local.
        let input = object(r#"{"streak":3}"#);
        let _ = field(&input, "streak");
        let recording = arm();
        assert!(recording.consumed_keys().is_empty());
    }

    #[test]
    fn a_panicking_dispatch_cannot_leave_the_recorder_armed() {
        let input = object(r#"{"streak":3}"#);
        let caught = std::panic::catch_unwind(|| {
            let _recording = arm();
            panic!("module blew up mid-dispatch");
        });
        assert!(caught.is_err());
        let _ = field(&input, "streak");
        let recording = arm();
        assert!(recording.consumed_keys().is_empty());
    }

    #[test]
    fn arming_clears_the_previous_dispatch() {
        let input = object(r#"{"streak":3}"#);
        {
            let _first = arm();
            let _ = field(&input, "streak");
        }
        let second = arm();
        assert!(second.consumed_keys().is_empty());
        assert!(second
            .unread_keys(input.as_object().expect("object"))
            .is_empty());
    }

    #[test]
    fn edit_distance_is_the_usual_metric() {
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("abc", "abd"), 1);
        assert_eq!(edit_distance("abc", ""), 3);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
    }

    fn json_number(n: u64) -> Value {
        serde_json::json!(n)
    }
}
