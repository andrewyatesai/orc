import { OrchestrationLegacyPrincipalStore } from './db-legacy-principals'
import { paramsJson } from './orchestration-store-bridge'
import { exposeMessageTimestamps } from './db-message-timestamp'
import { exposeQuestionTimestamps } from './db-row-timestamp-exposure'
import { rowFromJson } from './db-row-json'
import type {
  LegacyMailReceiptRow,
  LegacyOperationReceiptRow,
  MessagePriority,
  MessageRow,
  MessageType,
  QuestionRow,
  WorkerReportOutcome,
  WorkerReportSettlement
} from './types'

type LegacyOperationKey = {
  principalId: string
  operationKey: string
  method: string
  payloadHash: string
}

type LegacyMailPage = { messages: MessageRow[]; recovery: boolean }

type LegacyQuestionCommit = {
  receipt: LegacyOperationReceiptRow
  question: QuestionRow
  message: MessageRow
  duplicate: boolean
}

function exposeMailPage<T extends LegacyMailPage>(page: T): T {
  return { ...page, messages: page.messages.map(exposeMessageTimestamps) }
}

function exposeQuestionCommit(commit: LegacyQuestionCommit): LegacyQuestionCommit {
  return {
    ...commit,
    question: exposeQuestionTimestamps(commit.question),
    message: exposeMessageTimestamps(commit.message)
  }
}

export class OrchestrationLegacyOperationStore extends OrchestrationLegacyPrincipalStore {
  getLegacyMailPage(params: {
    principalId: string
    limit?: number
    types?: MessageType[]
  }): LegacyMailPage {
    return exposeMailPage(
      rowFromJson<LegacyMailPage>(this.store.getLegacyMailPage(paramsJson(params)))
    )
  }

  getLegacyMailHistory(params: { principalId: string; limit?: number; types?: MessageType[] }): {
    messages: MessageRow[]
    recovery: false
  } {
    return exposeMailPage(
      rowFromJson<{ messages: MessageRow[]; recovery: false }>(
        this.store.getLegacyMailHistory(paramsJson(params))
      )
    )
  }

  acknowledgeLegacyMail(params: {
    principalId: string
    messageIds: string[]
    types?: MessageType[]
  }): { receipts: LegacyMailReceiptRow[]; duplicate: boolean } {
    return rowFromJson<{ receipts: LegacyMailReceiptRow[]; duplicate: boolean }>(
      this.store.acknowledgeLegacyMail(paramsJson(params))
    )
  }

  acknowledgeLegacyQuestionAnswer(params: {
    principalId: string
    questionId: string
    answerMessageId: string
  }): { receipt: LegacyMailReceiptRow; duplicate: boolean } {
    return rowFromJson<{ receipt: LegacyMailReceiptRow; duplicate: boolean }>(
      this.store.acknowledgeLegacyQuestionAnswer(paramsJson(params))
    )
  }

  // Why no minted id: the store writes the `msg_<hex>` itself; `message.existingId`
  // is only ever a retry re-presenting an id an earlier attempt already minted.
  commitLegacyLifecycleOperation(
    params: LegacyOperationKey & {
      message: {
        existingId?: string
        to: string
        subject: string
        body?: string
        type: MessageType
        priority?: MessagePriority
        payload?: string
      }
      lifecycle:
        | { kind: 'message_only' }
        | { kind: 'heartbeat'; at: string }
        | {
            kind: 'worker_report'
            taskId: string
            outcome: WorkerReportOutcome
            result: string
          }
    }
  ): {
    receipt: LegacyOperationReceiptRow
    message: MessageRow
    settlement?: WorkerReportSettlement
    duplicate: boolean
  } {
    const commit = rowFromJson<{
      receipt: LegacyOperationReceiptRow
      message: MessageRow
      settlement?: WorkerReportSettlement
      duplicate: boolean
    }>(this.store.commitLegacyLifecycleOperation(paramsJson(params)))
    return { ...commit, message: exposeMessageTimestamps(commit.message) }
  }

  commitLegacyAskOperation(
    params: LegacyOperationKey & {
      question: string
      options?: string[]
      recipientHandle: string
      existingQuestionId?: string
    }
  ): LegacyQuestionCommit {
    return exposeQuestionCommit(
      rowFromJson<LegacyQuestionCommit>(this.store.commitLegacyAskOperation(paramsJson(params)))
    )
  }

  commitLegacyReplyOperation(
    params: LegacyOperationKey & { questionId: string; body: string }
  ): LegacyQuestionCommit {
    return exposeQuestionCommit(
      rowFromJson<LegacyQuestionCommit>(this.store.commitLegacyReplyOperation(paramsJson(params)))
    )
  }
}
