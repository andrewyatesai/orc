import { OrchestrationRunStore } from './db-runs'
import { generateId, paramsJson } from './orchestration-store-bridge'
import { exposeQuestionTimestamps } from './db-row-timestamp-exposure'
import { exposeMessageTimestamps } from './db-message-timestamp'
import { listFromJson, rowFromJson } from './db-row-json'
import type { MessageRow, QuestionRow } from './types'

type QuestionThread = { question: QuestionRow; message: MessageRow }

type LegacyQuestionMatch = QuestionThread & {
  answerAcknowledged: boolean
  claimedByOperation: boolean
}

type RemoteQuestionRow = {
  message_id: string
  dispatch_id: string
  status: 'pending' | 'answered' | 'closed'
  answer_message_id: string | null
  answer_body: string | null
}

// Why exposed here rather than in the getters: `question` and `message` are the
// two RFC3339-exposed row types, and every question result composes them.
function exposeQuestionThread<T extends QuestionThread>(thread: T): T {
  return {
    ...thread,
    question: exposeQuestionTimestamps(thread.question),
    message: exposeMessageTimestamps(thread.message)
  }
}

export class OrchestrationQuestionStore extends OrchestrationRunStore {
  createQuestion(params: {
    runId: string
    dispatchId: string
    askerHandle: string
    question: string
    options?: string[]
  }): QuestionThread {
    // The question message's id is also its thread id — the store stamps it.
    return exposeQuestionThread(
      rowFromJson<QuestionThread>(
        this.store.createQuestion(paramsJson({ ...params, messageId: generateId('msg') }))
      )
    )
  }

  getQuestion(messageId: string): QuestionRow | undefined {
    const json = this.store.getQuestion(messageId)
    return json === null ? undefined : exposeQuestionTimestamps(rowFromJson<QuestionRow>(json))
  }

  answerQuestion(params: {
    messageId: string
    runId: string
    consumerGeneration: number
    body: string
  }): QuestionThread & { duplicate: boolean } {
    return exposeQuestionThread(
      rowFromJson<QuestionThread & { duplicate: boolean }>(
        this.store.answerQuestion(paramsJson({ ...params, answerMessageId: generateId('msg') }))
      )
    )
  }

  closeQuestionsForDispatch(dispatchId: string): string[] {
    return this.store.closeQuestionsForDispatch(dispatchId)
  }

  // Why not exposed: db.ts applies no expose* to remote_questions rows, and
  // rewriting them here would be a new divergence.
  getRemoteQuestion(messageId: string): RemoteQuestionRow | undefined {
    const json = this.store.getRemoteQuestion(messageId)
    return json === null ? undefined : rowFromJson<RemoteQuestionRow>(json)
  }

  answerRemoteQuestion(params: {
    messageId: string
    dispatchId: string
    answerMessageId: string
    body: string
  }): void {
    this.store.answerRemoteQuestion(paramsJson(params))
  }

  registerFederatedQuestion(params: {
    messageId: string
    runId: string
    dispatchId: string
  }): void {
    // `messageId` is the already-imported relay message's id, never a fresh one.
    this.store.registerFederatedQuestion(paramsJson(params))
  }

  findPendingLegacyQuestions(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): QuestionThread[] {
    return listFromJson<QuestionThread>(
      this.store.findPendingLegacyQuestions(paramsJson(params))
    ).map(exposeQuestionThread)
  }

  findLegacyQuestionsBySemanticIdentity(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): LegacyQuestionMatch[] {
    return listFromJson<LegacyQuestionMatch>(
      this.store.findLegacyQuestionsBySemanticIdentity(paramsJson(params))
    ).map(exposeQuestionThread)
  }
}
