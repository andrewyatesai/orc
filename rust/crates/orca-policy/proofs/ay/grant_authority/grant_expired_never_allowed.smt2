; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Andrew Yates
;
; grant_authority — an EXPIRED grant can never authorize. By `ay`.
; Expected: unsat.
;
; Expiry is INCLUSIVE in the source: `if now_ms >= expires_at`. A grant is dead
; at its expiry instant, not one millisecond after — modeled with bvuge so the
; boundary is part of what is proved, not an off-by-one left to a test.
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

(assert expired)
(assert allowed)
(check-sat)
