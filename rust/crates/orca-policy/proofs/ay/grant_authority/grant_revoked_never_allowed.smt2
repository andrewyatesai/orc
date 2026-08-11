; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Andrew Yates
;
; grant_authority — a REVOKED grant can never authorize an operation. By `ay`.
; Expected: unsat  (the negation is unsatisfiable => no assignment of the other
;                   inputs lets a revoked grant reach `allowed`).
;
; FAITHFUL SOURCE (crates/orca-policy/src/lib.rs, decide_fleet_grant):
;     if grant.revoked { return Some(GrantDenial::Revoked) }
;     if let Some(expires_at) = grant.expires_at_ms { if now >= expires_at { ...Expired } }
;     if grant.generation != request.current_generation { ...WrongGeneration }
;     if !grant.ops.contains(op) { ...OpNotGranted }
;     let target = targets.find(handle) else { ...TargetNotGranted }
;     match (target.incarnation, request.incarnation) {
;         (None, _)            => None,                       ; wildcard: fleet-owned pane
;         (Some(_), None)      => Some(IncarnationChanged),    ; unknown => FAIL CLOSED
;         (Some(p), Some(a))   => if p == a { None } else { Some(IncarnationChanged) } }
;   Every arm is an early return, so `allowed` is the conjunction below.
;
; WHY IT MATTERS: revocation is the only way to take authority back from a worker
; that is already running. If a revoked grant could still authorize under some
; combination of generation/op/target, revocation would be advisory.
(set-logic QF_BV)
(declare-const revoked Bool)
(declare-const has_expiry Bool)
(declare-const now_ms (_ BitVec 64))
(declare-const expires_at (_ BitVec 64))
(declare-const gen_match Bool)
(declare-const op_granted Bool)
(declare-const target_found Bool)
(declare-const target_pinned Bool)
(declare-const incarnation_known Bool)
(declare-const incarnation_match Bool)

(define-fun expired () Bool (and has_expiry (bvuge now_ms expires_at)))
(define-fun incarnation_ok () Bool
  (or (not target_pinned)                              ; wildcard target
      (and incarnation_known incarnation_match)))      ; pinned: must be known AND equal
(define-fun allowed () Bool
  (and (not revoked) (not expired) gen_match op_granted target_found incarnation_ok))

(assert revoked)
(assert allowed)          ; negation: a revoked grant nonetheless authorizes
(check-sat)
