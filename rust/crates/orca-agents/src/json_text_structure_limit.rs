//! Structural pre-scan for untrusted JSON text, ported from
//! `src/shared/json-text-structure-limit.ts`.
//!
//! Callers run this BEFORE handing the text to a real JSON parser so a hostile
//! payload cannot spend parser time/stack on absurd nesting or token counts.
//! The twin throws `JsonTextStructureCapacityError`; every Rust caller so far
//! only needs the boolean, so the port returns one.
//!
//! FOLD-IN OWED: `agent_status_types` carries a byte-identical private copy of
//! this scan. It was left in place rather than de-duplicated because that file
//! is mid-rewrite on another branch; collapse it onto this module once that
//! lands.

/// `assertJsonTextStructureWithinLimits` as a predicate: false where the twin
/// throws. Counts only structural tokens outside string literals, tracking
/// escapes exactly as the twin does.
pub(crate) fn json_text_structure_within_limits(
    content: &str,
    structural_token_limit: usize,
    nesting_depth_limit: usize,
) -> bool {
    let mut structural_tokens = 0usize;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for character in content.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        if character == '"' {
            in_string = true;
            continue;
        }
        if !matches!(character, '{' | '}' | '[' | ']' | ',' | ':') {
            continue;
        }
        structural_tokens = structural_tokens.saturating_add(1);
        if structural_tokens > structural_token_limit {
            return false;
        }
        if character == '{' || character == '[' {
            depth = depth.saturating_add(1);
            if depth > nesting_depth_limit {
                return false;
            }
        } else if character == '}' || character == ']' {
            depth = depth.saturating_sub(1);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_excessive_nesting() {
        assert!(json_text_structure_within_limits("[[[0]]]", 64, 3));
        assert!(!json_text_structure_within_limits("[[[[0]]]]", 64, 3));
    }

    #[test]
    fn rejects_excessive_structural_tokens() {
        assert!(!json_text_structure_within_limits("[1,2,3,4]", 2, 8));
    }

    #[test]
    fn ignores_structural_characters_inside_strings() {
        // Braces in a string literal are not tokens, and `\"` does not close it.
        assert!(json_text_structure_within_limits(r#"{"a":"{[,:]}"}"#, 4, 2));
        assert!(json_text_structure_within_limits(r#"{"a":"\"{["}"#, 4, 2));
    }
}
