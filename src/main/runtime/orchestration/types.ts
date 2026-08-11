export type MessageType =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'merge_ready'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'heartbeat'

export type MessagePriority = 'normal' | 'high' | 'urgent'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'

/** `waiting_gate` (schema v9) parks a dispatch on an open gate instead of
 *  completing it, so the worker keeps its lease across the gate (design §6.2). */
// Why: the renderer's hibernation planner gates on this, so the union lives in
// shared and is re-exported here rather than declared twice.
import type { DispatchStatus } from '../../../shared/agent-status-types'

export type { DispatchStatus }

export type GateStatus = 'pending' | 'resolved' | 'timeout'

export type CoordinatorStatus = 'idle' | 'running' | 'completed' | 'failed'

/** Per-run gate policy (design §6.3). `human-only` is the default everywhere,
 *  including inside ALab missions; the other two are human pre-authorizations. */
export type GateResolutionPolicy = 'human-only' | 'standing-order' | 'manager-delegated'

export type MessageRow = {
  id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: string | null
  recipient_pane_key: string | null
}

export type TaskRow = {
  id: string
  parent_id: string | null
  created_by_terminal_handle: string | null
  task_title: string | null
  display_name: string | null
  spec: string
  status: TaskStatus
  deps: string
  result: string | null
  created_at: string
  completed_at: string | null
  /** Owning run (v9). Null while no run has adopted the task — a task created
   *  before any run exists, or one a pre-v9 build wrote. Read defensively: an
   *  un-owned task is normal, not a broken row. */
  run_id: string | null
}

export type DispatchContextRow = {
  id: string
  task_id: string
  assignee_handle: string | null
  assignee_pane_key: string | null
  status: DispatchStatus
  failure_count: number
  last_failure: string | null
  dispatched_at: string | null
  completed_at: string | null
  created_at: string
  last_heartbeat_at: string | null
  /** Owning run (v9); null for legacy rows and dispatches opened outside a run. */
  run_id: string | null
  /** Contract this dispatch was created under (v10): 0 = legacy (pre-capability
   *  row, backfilled by the migration), 1 = current. Never null. */
  contract_version: number
  /** SHA-256 hex of the launch token (v10); null until committed. */
  launch_token_hash: string | null
  /** SHA-256 hex of the dcap_ secret (v10); the secret itself is never
   *  persisted. Null = never minted, so no capability enforcement applies. */
  capability_hash: string | null
  process_incarnation: string | null
  /** Stamped on revoke and on dispatch completion/failure (v10). */
  capability_revoked_at: string | null
}

export type DecisionGateRow = {
  id: string
  task_id: string
  question: string
  options: string
  status: GateStatus
  resolution: string | null
  created_at: string
  resolved_at: string | null
  /** The `ask` message this gate answers, when one opened it. Null for gates from
   *  `gateCreate`, and for every gate written before schema v8 — always read defensively. */
  origin_message_id: string | null
  run_id: string | null
  /** Null means uncategorized, which §6.3 makes fail-closed human-only — it is
   *  never "any category". Every gate a pre-v9 build wrote reads null here. */
  category: string | null
  /** Applied on `hard_deadline_at` under `standing-order`; null disables fallthrough. */
  default_option: string | null
  manager_deadline_at: string | null
  hard_deadline_at: string | null
  /** JSON blob of the policy in force when the gate opened, so an audit read does
   *  not depend on the run row still saying what it said then. */
  policy_snapshot: string | null
  /** `human` | `manager:<handle>` | `service:<name>`; null until resolved. */
  resolved_by: string | null
  resolution_reason: string | null
  /** CAS operand — NOT NULL DEFAULT 0, so this is required, never nullable: a
   *  legacy row reads 0 and a caller can still present it to `resolvePendingGate`. */
  version: number
}

export type CoordinatorRun = {
  id: string
  spec: string
  status: CoordinatorStatus
  coordinator_handle: string
  poll_interval_ms: number
  created_at: string
  completed_at: string | null
  /** NOT NULL (v9): a run written before v9 backfills to the fail-closed default
   *  rather than leaving every consumer to decide what a null policy means. */
  gate_resolution_policy: GateResolutionPolicy
  /** JSON string array of delegable gate categories; only read under `manager-delegated`. */
  gate_category_allowlist: string
}

/** Append-only ledger row (design §7). The schema's UPDATE trigger aborts, so a
 *  correction is another event — there is deliberately no update path. */
export type AuditEventRow = {
  id: string
  /** Null for events recorded outside any run (grant changes, takeovers). */
  run_id: string | null
  actor: string
  action: string
  target_pane_key: string | null
  target_handle: string | null
  evidence_ref: string | null
  /** Redacted JSON detail — §7 forbids raw credentials or submitted text here. */
  detail: string | null
  created_at: string
}

/** `planned → source-quiesced → session-captured → target-prepared → target-spawned
 *  → resume-verified → committed`, with `needs-human` as the terminal failure. */
export type RotationSagaPhase =
  | 'planned'
  | 'source-quiesced'
  | 'session-captured'
  | 'target-prepared'
  | 'target-spawned'
  | 'resume-verified'
  | 'committed'
  | 'needs-human'

export type RotationSagaRow = {
  id: string
  provider: string
  phase: RotationSagaPhase
  /** RouteKey strings (design §3a) — never bare account ids. */
  source_route_key: string | null
  target_route_key: string
  /** Null means no credential surface to lock; NULLs stay distinct under the
   *  partial unique index, so they never collide with each other. */
  target_store_key: string | null
  /** Monotonic per target. A saga that renews and finds this moved has lost the
   *  reservation and must stop. */
  reservation_fence: number
  reservation_expires_at: string
  /** Null while the reservation is live — that is exactly what the partial unique
   *  indexes key on, so expiry alone does not free the target. */
  reservation_released_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string | null
}

/** Why a union rather than `DecisionGateRow | undefined`: a CAS loser must be able
 *  to tell "someone else already resolved this" — and read their answer — from
 *  "no such gate". Collapsing both to undefined loses the committed result. */
export type GateResolutionOutcome =
  | { outcome: 'resolved'; gate: DecisionGateRow; resumed_dispatch_id: string | null }
  | { outcome: 'version_conflict'; gate: DecisionGateRow }
  | { outcome: 'not_found' }

export type ReservationClaimOutcome =
  | { outcome: 'claimed'; saga: RotationSagaRow; swept_expired: number }
  /** Carries the live holder so a caller can name WHICH saga owns the successor. */
  | { outcome: 'conflict'; holder: RotationSagaRow }

export type MutationState = 'pending' | 'completed'

/** One row of the durable idempotency ledger (schema v11). Keyed by
 *  `(caller_fingerprint, request_id)`; `receipt` holds the serialized result a
 *  retry replays once the mutation has completed. */
export type MutationReceiptRow = {
  caller_fingerprint: string
  request_id: string
  method: string
  payload_hash: string
  state: MutationState
  receipt: string | null
  created_at: string
  updated_at: string
}
