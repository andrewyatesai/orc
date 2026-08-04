import { OrchestrationLegacyOperationStore } from './db-legacy-operations'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState
} from './types'

export type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState
}

export type { RunListPage } from './db-runs'

export const LEGACY_RUN_ID = ORCHESTRATION_LEGACY_RUN_ID

export const LEGACY_CONTRACT_VERSION = 0
export const CURRENT_CONTRACT_VERSION = ORCHESTRATION_CONTRACT_VERSION

/**
 * The multi-agent orchestration store: messages, the task DAG, dispatch
 * contexts and their capabilities, worker/remote dispatch lifecycle, Runs and
 * their mailbox deliveries, questions, federation relay, decision gates,
 * coordinator runs and the legacy-compatibility surface.
 *
 * This class is a shim: `orca_runtime::orchestration::OrchestrationDb` owns the
 * schema, the migrations and every query, and is reached through the
 * `OrchestrationStore` napi class. The `node:sqlite` twin is deleted. The shim
 * keeps only what Rust must not own — generated ids, ISO completion stamps, the
 * UTF-16-aware display derivation, and the RFC3339 timestamp exposure — so the
 * bytes on disk stay identical to what the TS store wrote.
 *
 * The surface is assembled from one class per domain (each file named for the
 * rows it speaks for) so no single file carries ~130 delegating methods;
 * `OrchestrationStoreBridge` is the shared napi seam at the bottom of the chain.
 */
export class OrchestrationDb extends OrchestrationLegacyOperationStore {}
