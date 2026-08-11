; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Andrew Yates
;
; grant_authority PROVE-AND-CATCH control — the revoked guard is load-bearing. By `ay`.
; Expected: sat.
;
; Identical model with the `(not revoked)` conjunct DROPPED. A revoked grant then
; authorizes, which refutes any claim that the rest of the chain would have caught
; it anyway. Pairs with grant_revoked_never_allowed (unsat) per the
; prove-and-catch contract in rust/PROOF_CARRYING_PERFORMANCE.md: the proof must
; fail when the guard it credits is removed, or it was never crediting that guard.
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
  (or (not target_pinned) (and incarnation_known incarnation_match)))
(define-fun allowed_without_revoke_check () Bool
  (and (not expired) gen_match op_granted target_found incarnation_ok))
(assert revoked)
(assert allowed_without_revoke_check)
(check-sat)
