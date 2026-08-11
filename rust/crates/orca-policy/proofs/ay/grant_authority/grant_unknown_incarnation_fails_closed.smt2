; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Andrew Yates
;
; grant_authority — a PINNED target with an UNKNOWN incarnation fails closed. By `ay`.
; Expected: unsat.
;
; THE SUBTLE ONE, and the reason this bundle exists. Source arm:
;     (Some(_), None) => Some(GrantDenial::IncarnationChanged)
; While the pane's real process incarnation is unknown, a respawn CANNOT be ruled
; out — so an unknown incarnation must deny, never wave through. The natural
; wrong port (`pinned == actual` with None treated as "no constraint") would let a
; grant issued for a dead process keep typing into whatever replaced it.
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
(define-fun allowed () Bool
  (and (not revoked) (not expired) gen_match op_granted target_found incarnation_ok))

(assert target_pinned)
(assert (not incarnation_known))
(assert allowed)
(check-sat)
