//! Parity dispatch for `orca_core::cross_platform_path` vs
//! `src/shared/cross-platform-path.ts`.

use orca_core::cross_platform_path::{
    create_normalized_path_inside_or_equal_matcher, get_runtime_path_basename,
    is_path_inside_or_equal, is_runtime_path_absolute, is_windows_absolute_path_like,
    normalize_runtime_path_for_comparison, normalize_runtime_path_separators,
    relative_path_inside_root, resolve_runtime_path, PathFlavor,
};
use serde_json::{json, Value};

/// Shape guard text, mirrored verbatim in `tools/parity/dispatch/cross-platform-path.ts`.
const MATCHER_SHAPE: &str = "createNormalizedPathInsideOrEqualMatcher expects \
     { rootPath: string, normalizedCandidate: string }";

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "isWindowsAbsolutePathLike" => {
            Value::Bool(is_windows_absolute_path_like(&string_field(input, "value")))
        }
        "normalizeRuntimePathSeparators" => {
            Value::String(normalize_runtime_path_separators(&string_field(input, "value")))
        }
        "normalizeRuntimePathForComparison" => Value::String(
            normalize_runtime_path_for_comparison(&string_field(input, "value")),
        ),
        // pathFlavor is optional: absent → None (the core auto-detects, matching
        // the TS default parameter).
        "isRuntimePathAbsolute" => {
            let flavor = input.get("pathFlavor").and_then(Value::as_str).map(|f| match f {
                "windows" => PathFlavor::Windows,
                _ => PathFlavor::Posix,
            });
            Value::Bool(is_runtime_path_absolute(&string_field(input, "value"), flavor))
        }
        "resolveRuntimePath" => Value::String(resolve_runtime_path(
            &string_field(input, "basePath"),
            &string_field(input, "targetPath"),
        )),
        "getRuntimePathBasename" => {
            Value::String(get_runtime_path_basename(&string_field(input, "value")))
        }
        "isPathInsideOrEqual" => Value::Bool(is_path_inside_or_equal(
            &string_field(input, "rootPath"),
            &string_field(input, "candidatePath"),
        )),
        // The twin returns a CLOSURE, which cannot cross a JSON boundary as a
        // value. What crosses is the predicate that closure APPLIES, so the vector
        // names the candidate it would have been called with and the TS adapter
        // drives the REAL closure with it — a differential on the closure's
        // behaviour, not on a serialized stand-in for the closure itself.
        //
        // What does NOT cross is the amortization: the twin folds the root once
        // per fan-out, this arm folds it once per candidate. A watcher-storm shim
        // should therefore keep the two-line comparison in TS over a
        // once-dispatched `normalizeRuntimePathForComparison` root; these vectors
        // are what pin that TS copy of the boundary rule to this core.
        //
        // Strict where the arms above default a missing key to "", because ""
        // folds to a root its own boundary test answers TRUE for: a no-arg or
        // misspelled call would report every path as contained on the predicate
        // that gates worktree removal, session delete and filesystem auth. The
        // twin throws a TypeError on a non-string candidate, so refusing is the
        // same contract — `decodeDispatchResult` turns `__parity_error__` into a
        // thrown DispatchCoreError.
        "createNormalizedPathInsideOrEqualMatcher" => match (
            input.get("rootPath").and_then(Value::as_str),
            input.get("normalizedCandidate").and_then(Value::as_str),
        ) {
            (Some(root_path), Some(normalized_candidate)) => Value::Bool(
                create_normalized_path_inside_or_equal_matcher(root_path)
                    .matches(normalized_candidate),
            ),
            _ => json!({ "__parity_error__": MATCHER_SHAPE }),
        },
        // TS returns `string | null`; `JSON.stringify` keeps the literal `null`,
        // so a non-contained candidate maps to `Value::Null`, not an omitted key.
        "relativePathInsideRoot" => match relative_path_inside_root(
            &string_field(input, "rootPath"),
            &string_field(input, "candidatePath"),
        ) {
            Some(rel) => Value::String(rel),
            None => Value::Null,
        },
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Reads a string argument from the vector input object. Vectors always carry
/// the keys, so a missing one is a vector bug; default to empty rather than panic.
fn string_field(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // These drive `dispatch` rather than the core, because the gap being closed
    // was REGISTRATION, not implementation: the core has had the matcher since
    // the port, and both shipped cores still answered
    // "unknown function createNormalizedPathInsideOrEqualMatcher".

    /// The composition a fan-out shim performs: fold the candidate through the
    /// registry, then ask the matcher arm about it.
    fn matches(root_path: &str, candidate_path: &str) -> Value {
        let normalized = dispatch(
            "normalizeRuntimePathForComparison",
            &json!({ "value": candidate_path }),
        );
        dispatch(
            "createNormalizedPathInsideOrEqualMatcher",
            &json!({ "rootPath": root_path, "normalizedCandidate": normalized }),
        )
    }

    fn inside_or_equal(root_path: &str, candidate_path: &str) -> Value {
        dispatch(
            "isPathInsideOrEqual",
            &json!({ "rootPath": root_path, "candidatePath": candidate_path }),
        )
    }

    // Translated from the twin's own fan-out case in
    // src/shared/cross-platform-path-resolution.test.ts, "agrees with the matcher
    // fan-out on an already-normalized candidate" — same root, same three
    // candidates, same oracle.
    #[test]
    fn agrees_with_is_path_inside_or_equal_on_an_already_normalized_candidate() {
        let root = "\\\\wsl$\\Ubuntu\\home\\Alice\\repo";
        for candidate in [
            "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src",
            "\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src",
            "\\\\wsl$\\Ubuntu\\home\\Alice\\repo",
        ] {
            assert_eq!(
                matches(root, candidate),
                inside_or_equal(root, candidate),
                "candidate {candidate}"
            );
        }
        // Absolute answers, so the agreement above cannot be two identical wrongs:
        // the WSL alias and distro case fold, the Linux tail does not.
        assert_eq!(
            matches(root, "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src"),
            Value::Bool(true)
        );
        assert_eq!(
            matches(root, "\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src"),
            Value::Bool(false)
        );
    }

    /// The misuse the twin's doc comment warns about: the comparison fold is not
    /// idempotent for WSL UNC, so a RAW candidate must not match.
    #[test]
    fn a_raw_candidate_does_not_match_a_folded_root() {
        assert_eq!(
            dispatch(
                "createNormalizedPathInsideOrEqualMatcher",
                &json!({
                    "rootPath": "\\\\wsl$\\Ubuntu\\repo",
                    "normalizedCandidate": "\\\\wsl.localhost\\ubuntu\\repo\\src"
                })
            ),
            Value::Bool(false)
        );
    }

    /// Every root × candidate pair the twin's pre-ready sweep probes
    /// (`probeAll` in cross-platform-path-resolution.test.ts), asserting the arm
    /// answers what the containment arm answers. Wiring, not logic: it fails if
    /// the arm reads the wrong key or is not registered at all.
    #[test]
    fn the_twins_whole_probe_cross_product_routes() {
        const KOREAN_NFD_ROOT: &str = "/userhome/ada/\u{1111}\u{1173}\u{1105}\u{1169}\u{110C}\
            \u{1166}\u{11A8}\u{1110}\u{1173}";
        let roots = [
            "/repo/app",
            "/srv/team\\repo",
            "C:\\Repo",
            "C:\\",
            "\\\\Server\\Share\\Repo\\",
            "\\\\wsl$\\Ubuntu\\home\\Alice\\repo",
            KOREAN_NFD_ROOT,
            "\u{212A}:/a\\b",
            "/",
        ];
        let candidates = [
            "/repo/app/src/index.ts",
            "/repo/application/src/index.ts",
            "/srv/team/repo/file.ts",
            "c:\\repo\\src\\index.ts",
            "//server/share/repo/src",
            "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src",
            "/userhome/ada/\u{D504}\u{B85C}\u{C81D}\u{D2B8}/src/\u{1F389}file.ts",
            "\u{212A}:/a\\b/c",
            "//server/share/x",
            "../worktrees/feature",
            "D:\\worktrees",
        ];
        let mut contained = 0;
        for root in roots {
            for candidate in candidates {
                let answer = matches(root, candidate);
                assert_eq!(
                    answer,
                    inside_or_equal(root, candidate),
                    "root {root} candidate {candidate}"
                );
                if answer == Value::Bool(true) {
                    contained += 1;
                }
            }
        }
        // A registration bug that answered `false` everywhere would agree with
        // nothing; pin that real containments were actually exercised (7 of the
        // 14 are under the POSIX root '/').
        assert_eq!(contained, 14);
    }

    /// A missing or non-string field is REFUSED, not folded to "": the empty root
    /// folds to a boundary the empty candidate satisfies, so the default would
    /// answer `true` — every path contained — on the predicate that gates
    /// destructive work.
    #[test]
    fn refuses_a_missing_or_non_string_field_instead_of_answering_contained() {
        let refusal = json!({ "__parity_error__": MATCHER_SHAPE });
        for input in [
            Value::Null,
            json!({}),
            json!({ "rootPath": "/repo" }),
            json!({ "normalizedCandidate": "/repo/src" }),
            json!({ "rootPath": "/repo", "normalizedCandidate": 7 }),
            json!({ "rootPath": null, "normalizedCandidate": "/repo/src" }),
        ] {
            assert_eq!(
                dispatch("createNormalizedPathInsideOrEqualMatcher", &input),
                refusal,
                "input {input}"
            );
        }
        // What the refusal is protecting against, stated as an assertion.
        assert_eq!(
            dispatch(
                "createNormalizedPathInsideOrEqualMatcher",
                &json!({ "rootPath": "", "normalizedCandidate": "" })
            ),
            Value::Bool(true)
        );
    }

    #[test]
    fn an_unregistered_function_still_reports_unknown() {
        assert_eq!(
            dispatch("createMatcher", &json!({})),
            json!({ "__parity_error__": "unknown function createMatcher" })
        );
    }
}
