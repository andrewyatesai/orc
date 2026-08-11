; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Andrew Yates
;
; grant_authority NON-VACUITY — `allowed` is actually reachable. By `ay`.
; Expected: sat.
;
; Without this the three unsat obligations above would be satisfied by a model in
; which nothing is ever allowed — every "never authorizes" claim holds trivially
; against a function that authorizes nothing. This pins that the guard chain has a
; satisfying assignment, so the unsat results are about REVOCATION/EXPIRY/PINNING
; rather than about an empty decision space.
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

(assert allowed)
(check-sat)
