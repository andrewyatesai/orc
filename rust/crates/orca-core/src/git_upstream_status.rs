//! Upstream-status reconciliation helpers, ported from
//! `src/shared/git-upstream-status.ts`.
//!
//! Decides whether upstream-only commits are patch-equivalent (rebased copies)
//! and whether a lease-protected force push is the correct reconciliation.

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitUpstreamStatus {
    pub has_upstream: bool,
    pub upstream_name: Option<String>,
    /// JS `number`, i.e. an f64 — NOT an integer count. The twin compares these
    /// with `===` and `>`, and at the JSON boundary they can arrive absent, as
    /// `0.5`, or beyond i64's range. An i64 field coerced all three to 0, so
    /// `{hasUpstream:true, behind:4}` answered "behind-only" where the twin says
    /// no, because `undefined === 0` is false. NaN carries "absent or not a
    /// number": every comparison against it is false in Rust exactly as in JS.
    pub ahead: f64,
    pub behind: f64,
    /// Set (Some(true)) only when the remote-tracking ref for an explicit publish
    /// target hasn't been fetched yet: there's no upstream to compare against, but
    /// the branch CAN still be published. Absent otherwise (mirrors the TS
    /// `hasConfiguredPushTarget?` optional the "can still publish" UI reads).
    pub has_configured_push_target: Option<bool>,
    /// When a branch was rebased, upstream-only commits can be older
    /// patch-equivalent copies; pulling them reintroduces stale history.
    pub behind_commits_are_patch_equivalent: Option<bool>,
}

/// True when `git cherry`-style `-`/`=` marks all indicate patch-equivalence
/// (`=`) and there is at least one commit to judge.
pub fn upstream_only_commits_are_patch_equivalent(cherry_mark_output: &str) -> bool {
    let lines: Vec<&str> = cherry_mark_output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    !lines.is_empty() && lines.iter().all(|line| line.starts_with('='))
}

pub fn should_force_push_with_lease_for_upstream(status: Option<&GitUpstreamStatus>) -> bool {
    match status {
        Some(s) => {
            s.has_upstream
                && s.ahead > 0.0
                && s.behind > 0.0
                && s.behind_commits_are_patch_equivalent == Some(true)
        }
        None => false,
    }
}

/// Behind-only is the one auto-prepare case Create PR can settle with a pure
/// fast-forward: no local unique commits to reconcile. Eligibility and the
/// intent remote-step resolver share this predicate so the button and the
/// one-click flow never disagree on what "behind-only" means.
pub fn is_behind_only_upstream(status: Option<&GitUpstreamStatus>) -> bool {
    match status {
        Some(s) => s.has_upstream && s.ahead == 0.0 && s.behind > 0.0,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_equivalent_requires_all_equals_marks_and_at_least_one_line() {
        assert!(upstream_only_commits_are_patch_equivalent("= abc\n= def\r\n"));
        assert!(!upstream_only_commits_are_patch_equivalent("= abc\n- def"));
        assert!(!upstream_only_commits_are_patch_equivalent("   \n  "));
        assert!(!upstream_only_commits_are_patch_equivalent(""));
    }

    #[test]
    fn force_push_only_when_diverged_and_patch_equivalent() {
        let diverged = GitUpstreamStatus {
            has_upstream: true,
            ahead: 2.0,
            behind: 3.0,
            behind_commits_are_patch_equivalent: Some(true),
            ..Default::default()
        };
        assert!(should_force_push_with_lease_for_upstream(Some(&diverged)));

        let not_equivalent = GitUpstreamStatus {
            behind_commits_are_patch_equivalent: Some(false),
            ..diverged.clone()
        };
        assert!(!should_force_push_with_lease_for_upstream(Some(&not_equivalent)));

        let only_ahead = GitUpstreamStatus { behind: 0.0, ..diverged.clone() };
        assert!(!should_force_push_with_lease_for_upstream(Some(&only_ahead)));

        assert!(!should_force_push_with_lease_for_upstream(None));
    }

    /// Verbatim translation of the twin's
    /// `isBehindOnlyUpstream > is true only when the branch tracks upstream and
    /// is purely behind` case in `src/shared/git-upstream-status.test.ts`.
    #[test]
    fn behind_only_requires_tracking_upstream_and_zero_ahead() {
        assert!(is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: 0.0,
            behind: 3.0,
            ..Default::default()
        })));
        assert!(!is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: 1.0,
            behind: 2.0,
            ..Default::default()
        })));
        assert!(!is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: 0.0,
            behind: 0.0,
            ..Default::default()
        })));
        assert!(!is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: false,
            ahead: 0.0,
            behind: 3.0,
            ..Default::default()
        })));
        assert!(!is_behind_only_upstream(None));
    }

    /// Boundary the twin's suite never states: TS `ahead === 0` is exact, so a
    /// negative counter (a malformed status) is NOT behind-only, and `behind`
    /// must be strictly positive.
    #[test]
    fn behind_only_counter_boundaries_match_strict_ts_comparisons() {
        assert!(!is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: -1.0,
            behind: 3.0,
            ..Default::default()
        })));
        assert!(!is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: 0.0,
            behind: -2.0,
            ..Default::default()
        })));
        assert!(is_behind_only_upstream(Some(&GitUpstreamStatus {
            has_upstream: true,
            ahead: 0.0,
            behind: 1.0,
            ..Default::default()
        })));
    }
}
