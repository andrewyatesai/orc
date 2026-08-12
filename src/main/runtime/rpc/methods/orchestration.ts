/* eslint-disable max-lines -- Why: RPC method definitions co-locate param schemas with handlers; splitting by method would scatter the shared enums and Zod transforms without reducing complexity. */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, OptionalBoolean, requiredString } from '../schemas'
import type {
  MessageType,
  MessagePriority,
  TaskStatus,
  OrchestrationDb,
  DispatchContextRow
} from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { formatMessageBanner } from '../../orchestration/formatter'
import { isGroupAddress, resolveGroupAddress } from '../../orchestration/groups'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { abbreviateOrchestrationTasks } from '../../../../shared/orchestration-task-summary'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { SETTLED_DISPATCH_STATUSES } from '../../../../shared/agent-status-types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'
import { createOrchestrationRowReach } from '../../orchestration/row-caller-scope'
import { assertLocalCallerScope, getCallerScope } from '../../runtime-caller-scope'
import {
  orchestrationCallerFingerprint,
  withMutationReceipt,
  type MutationIdempotency
} from './orchestration-idempotency'

const MESSAGE_TYPES: MessageType[] = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'heartbeat'
]

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

// Why (v10): capability enforcement is scoped to dispatches that were MINTED a
// capability (capability_hash set) — legacy dispatches keep pane-key authority
// only, so the upgrade is a ratchet, not a flag-day. The dispatch id comes from
// the message payload because that is how workers already thread identity.
function getMintedDispatchForLifecyclePayload(
  db: OrchestrationDb,
  payload: string | undefined
): DispatchContextRow | undefined {
  if (!payload) {
    return undefined
  }
  let dispatchId: unknown
  try {
    dispatchId = (JSON.parse(payload) as { dispatchId?: unknown }).dispatchId
  } catch {
    return undefined
  }
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    return undefined
  }
  const dispatch = db.getDispatchContextById(dispatchId)
  return dispatch?.capability_hash ? dispatch : undefined
}

function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages must be sent to a concrete coordinator terminal handle, not a group address.`
}

// Why: a reminted-away handle no longer resolves a pane in the runtime, but the
// pane key persisted on earlier rows to the same handle still names the live
// pane — the DB is the durable handle→pane memory (#9163 delivery-follows-identity).
function lastPersistedRecipientPaneKey(db: OrchestrationDb, toHandle: string): string | undefined {
  return (
    db.getAllMessagesForHandle(toHandle, 20).find((m) => m.recipient_pane_key)
      ?.recipient_pane_key ?? undefined
  )
}

const SendParams = z
  .object({
    to: requiredString('Missing --to'),
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    body: OptionalString,
    type: z
      .enum([
        'status',
        'dispatch',
        'worker_done',
        'merge_ready',
        'escalation',
        'handoff',
        'decision_gate',
        'heartbeat'
      ])
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Why: pane key is the remint-stable identity used to verify worker_done/heartbeat ownership; the from handle stays routing metadata.
    senderPaneKey: OptionalString,
    // Why (v10): the dcap_ secret the dispatch preamble handed the worker.
    // Presented per-send and never persisted; the store compares its hash.
    dispatchCapability: OptionalString,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (
      (params.type !== 'worker_done' && params.type !== 'heartbeat') ||
      !isGroupAddress(params.to)
    ) {
      return
    }
    // Why: dispatch lifecycle messages are authority/liveness signals for one coordinator; fanout would create lifecycle mail in unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })

const CheckParams = z
  .object({
    terminal: OptionalString,
    unread: OptionalBoolean,
    peek: OptionalBoolean,
    // Why: `all` surfaces every message and skips mark-read; legacy encoding was the `{unread: false}` trick (design doc §3.2/§3.3).
    all: OptionalBoolean,
    types: OptionalString,
    inject: OptionalBoolean,
    wait: OptionalBoolean,
    timeoutMs: OptionalFiniteNumber
  })
  .superRefine((params, ctx) => {
    // Why: CLI encodes --peek as {peek:true, unread:false} for pre-peek runtimes, so that pair is one mode, not a conflict.
    const modes = [
      params.unread === true,
      params.peek === true,
      params.all === true || (params.unread === false && params.peek !== true)
    ].filter(Boolean)
    if (modes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose at most one message read mode: --unread, --peek, or --all.'
      })
    }
  })

const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString
})

const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox to a handle so inbox and check --all give agreeing results (design doc §3.3).
  terminal: OptionalString
})

const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString,
  // Why: a stable, client-minted key makes a reconnect retry replay the created
  // task instead of minting a duplicate. Optional — omitting it is legacy behavior.
  idempotencyKey: OptionalString
})

const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean,
  // Why: server-side truncation keeps --brief cheap over SSH/relay instead of shipping full specs the CLI throws away.
  brief: OptionalBoolean,
  runId: OptionalString
})

const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString
})

const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is optional so --dry-run can preview without a target; the handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean,
  // Why: a reconnect retry double-dispatches (a second ctx + a second preamble
  // injected into the pane); a stable key makes the retry replay the first
  // dispatch. Optional — omitting it is legacy behavior.
  idempotencyKey: OptionalString
})

const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

const AskParams = z.object({
  to: requiredString('Missing --to'),
  question: requiredString('Missing --question'),
  options: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  from: OptionalString,
  /** Naming the blocked task opens a decision gate, so a human sees the question in
   *  the queue instead of only the addressed agent. Without it `ask` stays agent↔agent. */
  task: OptionalString
})

const ResetParams = z
  .object({
    all: OptionalBoolean,
    tasks: OptionalBoolean,
    messages: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    const selectedScopeCount = [params.all, params.tasks, params.messages].filter(
      (scope) => scope === true
    ).length
    if (selectedScopeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      })
    }
  })

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Why: older shells may lack ORCA_PANE_KEY, but the runtime still knows the pane behind their handle; persist that authority.
      const senderPaneKey = params.senderPaneKey ?? runtime.getTerminalPaneKey(from) ?? undefined

      if (!isGroupAddress(params.to)) {
        // Why: point-to-point mail is delivered by the persisted pane key when the
        // handle registry no longer holds the recipient, so the registry's own
        // bound is not the only path to the pane — name the recipient here.
        runtime.assertTerminalHandleInCallerScope(params.to, 'message recipient')
        // Why: the pane key is the remint-stable recipient identity — persisted so
        // delivery can follow the pane when the addressed handle goes stale (#9163).
        const recipientPaneKey =
          runtime.getTerminalPaneKey(params.to) ?? lastPersistedRecipientPaneKey(db, params.to)
        // Point-to-point — existing single-recipient behavior
        const msg = db.insertMessage({
          from,
          to: params.to,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId: params.threadId,
          payload: params.payload,
          senderPaneKey,
          recipientPaneKey
        })
        // Why (v10, before reconcile): a minted dispatch requires the presented
        // dcap_ secret to hash-match, from an equivalent pane and the SAME
        // process incarnation (runtime-derived from the sender, so a spoofed
        // pane key alone no longer grants lifecycle authority). Failure is
        // persisted as a coded rejection so later re-reads stay rejected.
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          const minted = getMintedDispatchForLifecyclePayload(db, msg.payload ?? undefined)
          if (minted) {
            const authority = db.capabilities.verify({
              dispatchId: minted.id,
              capability: params.dispatchCapability,
              // Prefer the runtime-observed pane; caller-supplied is only the
              // SSH/CLI fallback where the runtime cannot resolve the sender.
              paneKey: runtime.getTerminalPaneKey(from) ?? params.senderPaneKey,
              processIncarnation: runtime.getTerminalProcessIncarnation?.(from) ?? undefined
            })
            // Why (revoke-on-terminate carve-out): complete/fail stamp
            // capability_revoked_at, so a legitimate straggler (late heartbeat,
            // duplicate worker_done) fails verify AFTER its dispatch settled.
            // verify checks revocation before the token, so on this row (hash
            // present per the minted predicate) revoked_at set ⟺ the revoked
            // verdict — settled + revoked is the straggler shape, not an attack.
            // Fall through to reconcile, which already no-ops a terminal
            // dispatch's lifecycle mail quietly (pre-v10 behavior). Wrong or
            // absent tokens on an ACTIVE dispatch, and revoked-but-still-active
            // presentations, stay hard rejections.
            const isSettledStraggler =
              Boolean(minted.capability_revoked_at) &&
              SETTLED_DISPATCH_STATUSES.includes(minted.status)
            if (!authority.valid && !isSettledStraggler) {
              const rejection =
                db.convertLifecycleMessageToRejection(
                  msg.id,
                  authority.reason,
                  'dispatch_capability_invalid'
                ) ?? msg
              runtime.deliverPendingMessagesForHandle(params.to, recipientPaneKey)
              runtime.notifyMessageArrived(params.to, rejection.type, recipientPaneKey)
              return {
                message: rejection,
                lifecycle: {
                  action: 'rejected',
                  code: 'dispatch_capability_invalid',
                  reason: authority.reason
                }
              }
            }
          }
        }
        // Why: reconcile releases the dispatch lock before waking recipients, else a woken coordinator re-dispatches while the lock is still held.
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          const reconciled = reconcileLifecycleMessage(db, msg)
          // Why: a suppressed message is already read, so skip the notify that would wake a check --wait waiter to an empty result.
          if (reconciled.action === 'suppressed') {
            return { message: msg }
          }
          if (reconciled.action === 'rejected') {
            const rejection = db.getMessageById(msg.id) ?? msg
            runtime.deliverPendingMessagesForHandle(params.to, recipientPaneKey)
            runtime.notifyMessageArrived(params.to, rejection.type, recipientPaneKey)
            return { message: rejection, lifecycle: reconciled }
          }
        }
        runtime.deliverPendingMessagesForHandle(params.to, recipientPaneKey)
        runtime.notifyMessageArrived(params.to, msg.type, recipientPaneKey)
        return { message: msg }
      }

      // Why: fan out one message per recipient (independent read-tracking) but share a thread_id for correlation (Section 4.5).
      const { terminals } = await runtime.listTerminals(undefined, undefined, {
        includeVisualLayouts: false
      })
      const handles = resolveGroupAddress(
        params.to,
        from,
        terminals,
        (handle: string) => runtime.getAgentStatusForHandle(handle),
        (terminal) => runtime.isWorktreeReachableByCaller(terminal.worktreeId)
      )

      if (handles.length === 0) {
        throw new Error(`No recipients resolved for group address: ${params.to}`)
      }

      const threadId = params.threadId ?? `thread_${Date.now()}`
      const messages = handles.map((handle) =>
        db.insertMessage({
          from,
          to: handle,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId,
          payload: params.payload,
          senderPaneKey,
          recipientPaneKey: runtime.getTerminalPaneKey(handle) ?? undefined
        })
      )
      for (const message of messages) {
        runtime.deliverPendingMessagesForHandle(
          message.to_handle,
          message.recipient_pane_key ?? undefined
        )
        runtime.notifyMessageArrived(
          message.to_handle,
          message.type,
          message.recipient_pane_key ?? undefined
        )
      }

      return { messages, recipients: handles.length }
    }
  }),

  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (params, { runtime, signal }) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      // Why: reading a mailbox consumes it — the unread rows are marked read —
      // so the mailbox is the object here, exactly as the recipient is on send.
      runtime.assertTerminalHandleInCallerScope(handle, 'mailbox')
      const typeFilter = params.types
        ? (params.types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean) as MessageType[])
        : undefined
      const invalidTypes = typeFilter?.filter((t) => !MESSAGE_TYPES.includes(t))
      if (invalidTypes && invalidTypes.length > 0) {
        throw new Error(`Invalid --types: ${invalidTypes.join(',')}`)
      }

      // Why: unread:false is honored for one release as a compat shim so in-flight callers don't break (design doc §5).
      const showAll = params.all === true || (params.unread === false && params.peek !== true)
      const consumeUnread = !showAll && params.peek !== true

      const readAndReturn = () => {
        const messages = showAll
          ? db.getAllMessagesForHandle(handle, undefined, typeFilter)
          : db.getUnreadMessages(handle, typeFilter)

        let visibleMessages = messages
        if (consumeUnread && messages.length > 0) {
          // Why: unread check is an authoritative read path for worker_done/heartbeat, so reconcile lifecycle messages here too.
          visibleMessages = messages.map((message) => {
            const reconciled = reconcileLifecycleMessage(db, message)
            return reconciled.action === 'rejected'
              ? (db.getMessageById(message.id) ?? message)
              : message
          })
          db.markAsRead(messages.map((m) => m.id))
        }

        if (params.inject) {
          const formatted = visibleMessages.map(formatMessageBanner).join('\n\n')
          return { messages: visibleMessages, formatted, count: visibleMessages.length }
        }

        return { messages: visibleMessages, count: visibleMessages.length }
      }

      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      const result = readAndReturn()
      if (result.count > 0 || !params.wait) {
        return result
      }

      // Why: signal aborts this waiter when the client socket closes, freeing the long-poll slot immediately rather than after timeoutMs (design doc §3.1).
      await runtime.waitForMessage(handle, {
        typeFilter: typeFilter as string[] | undefined,
        timeoutMs: params.timeoutMs ?? undefined,
        signal
      })
      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      return readAndReturn()
    }
  }),

  defineMethod({
    name: 'orchestration.reply',
    params: ReplyParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const original = db.getMessageById(params.id)
      if (!original) {
        throw new Error(`Message not found: ${params.id}`)
      }
      // Why both: replying reads and consumes the addressed pane's mail, and then
      // delivers into the original sender's pane. A message id names both panes
      // without either appearing in the params.
      runtime.assertTerminalHandleInCallerScope(original.to_handle, 'mailbox')
      runtime.assertTerminalHandleInCallerScope(original.from_handle, 'reply recipient')

      db.markAsRead([original.id])

      const reply = db.insertMessage({
        from: params.from ?? original.to_handle,
        to: original.from_handle,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id
      })

      runtime.notifyMessageArrived(original.from_handle, reply.type)
      return { message: reply }
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.terminal) {
        runtime.assertTerminalHandleInCallerScope(params.terminal, 'mailbox')
      }
      // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
      const messages = params.terminal
        ? db.getAllMessagesForHandle(params.terminal, params.limit)
        : // Why filtered, not refused: an unaddressed inbox IS the mail catalog —
          // every pane's traffic in one list — so a bounded caller sees the rows
          // between panes it reaches and never learns the rest exist.
          db
            .getInbox(params.limit)
            .filter(
              (message) =>
                runtime.isTerminalHandleReachableByCaller(message.to_handle) &&
                runtime.isTerminalHandleReachableByCaller(message.from_handle)
            )
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: a task is work a coordinator will dispatch into a pane, so the pane
      // that asked for it is the object. A bounded caller naming none is writing
      // into the queue of the machine running Orca with nothing to bound it to.
      // The CLI treats the handle as best-effort lineage, so it sends whatever
      // ORCA_TERMINAL_HANDLE it holds rather than pre-judging liveness — this
      // registry is what decides, and unreachable is the same as absent here.
      // Why before the receipt: authority gates the ledger, so an unauthorized
      // retry is refused by scope, never replayed from a stored task.
      if (params.callerTerminalHandle) {
        runtime.assertTerminalHandleInCallerScope(params.callerTerminalHandle, 'task creator')
      } else {
        assertLocalCallerScope(getCallerScope(), 'a task that names no creating terminal')
      }
      const idempotency: MutationIdempotency | undefined = params.idempotencyKey
        ? {
            callerFingerprint: orchestrationCallerFingerprint(runtime, params.callerTerminalHandle),
            requestId: params.idempotencyKey,
            method: 'orchestration.taskCreate',
            payload: params
          }
        : undefined
      return withMutationReceipt(db, idempotency, () => {
        let deps: string[] | undefined
        if (params.deps) {
          try {
            const parsed = JSON.parse(params.deps)
            if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
              throw new Error('not an array of strings')
            }
            deps = parsed
          } catch {
            throw new Error('Invalid --deps: must be a JSON array of task IDs')
          }
        }
        const task = db.createTask({
          spec: params.spec,
          taskTitle: params.taskTitle,
          displayName: params.displayName,
          deps,
          parentId: params.parent,
          createdByTerminalHandle: params.callerTerminalHandle
        })
        return { task }
      })
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: listTasksWithDispatch adds assignee_handle + dispatch_id (NULL for non-dispatched), so legacy-shape consumers are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready
      })
      // Why filtered here and not in SQL: the dispatch-join accessor takes no run
      // bind, and this read was already whole-workspace, so narrowing the response
      // costs nothing extra. An omitted runId stays "no filter", never "un-owned".
      const owned = params.runId ? joined.filter((row) => row.run_id === params.runId) : joined
      // Why filtered, not refused: this list IS the workspace task catalog —
      // every pane's work in one response — so a bounded caller sees the tasks
      // its own panes created, ran or coordinate and never learns the rest exist.
      const reach = createOrchestrationRowReach(db, runtime)
      const visible = owned.filter((row) => reach.task(row))
      const tasks = visible.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return {
        tasks: params.brief ? abbreviateOrchestrationTasks(tasks) : tasks,
        count: tasks.length
      }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why before the write: a status change releases dependents and unparks the
      // coordinator loop that owns the task, so the task is the object here — the
      // same one taskList filters the catalog by.
      createOrchestrationRowReach(db, runtime).assertTaskId(params.id)
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }

      // Why above the dry-run return and not beside the side effects: a dry run
      // still reads both objects — the preamble it returns carries the task spec
      // verbatim, and --to is the pane it would be injected into.
      if (params.to) {
        // Why: --inject writes the preamble into the addressed pane's agent, so
        // the assignee is the object being driven; same second delivery path as send.
        runtime.assertTerminalHandleInCallerScope(params.to, 'dispatch assignee')
      }
      createOrchestrationRowReach(db, runtime).assertTask(task)

      // Why: dry-run previews the preamble without mutating state, so it skips the ready-status check, uses a placeholder dispatchId, and is never receipted.
      if (params.dryRun) {
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle: params.to ?? 'worker',
          devMode: params.devMode,
          personalizationPrompt: await runtime.getPersonalizationPrompt(params.to),
          ...(params.to
            ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(params.to) }
            : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      // Why before the receipt: --to presence is argument validation and the
      // caller-scope authority above must gate the ledger, so an unauthorized or
      // malformed retry is refused here rather than replayed from a stored dispatch.
      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      const idempotency: MutationIdempotency | undefined = params.idempotencyKey
        ? {
            callerFingerprint: orchestrationCallerFingerprint(runtime, params.from),
            requestId: params.idempotencyKey,
            method: 'orchestration.dispatch',
            payload: params
          }
        : undefined

      // Why the whole mutating body is inside the receipt: a completed retry must
      // replay the stored dispatch WITHOUT re-running the ready-status check (the
      // task is 'dispatched' by then) or re-injecting the preamble.
      return withMutationReceipt(db, idempotency, async () => {
        if (task.status !== 'ready') {
          throw new Error(
            `Task ${params.task} is ${task.status}; only ready tasks can be dispatched`
          )
        }

        // Why: injecting the preamble into a bare shell dumps it as shell commands (gibberish), so require a detected agent first.
        if (params.inject) {
          const hasAgent = await runtime.isTerminalRunningAgent(to)
          if (!hasAgent) {
            throw new Error(
              `Cannot dispatch --inject to terminal ${to}: no recognized agent detected. ` +
                'Start an agent CLI (e.g. claude, codex, gemini, droid, cursor) in the terminal first, ' +
                'or dispatch without --inject and send the prompt manually.'
            )
          }
        }

        const assigneePaneKey = runtime.getTerminalPaneKey(to) ?? undefined
        const ctx = db.createDispatchContext(params.task, to, assigneePaneKey)

        // v10: same ratchet as the coordinator loop — mint only when the runtime
        // can identify the target's pane AND process incarnation; otherwise the
        // dispatch stays legacy (no capability_hash -> no enforcement).
        const processIncarnation = runtime.getTerminalProcessIncarnation?.(to) ?? undefined
        const dispatchCapability =
          assigneePaneKey && processIncarnation
            ? db.capabilities.mint({
                dispatchId: ctx.id,
                paneKey: assigneePaneKey,
                processIncarnation
              })
            : undefined

        // Why: built after ctx so dispatchId is the real ctx.id, letting heartbeats attribute liveness to a specific dispatch context, not just a task.
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: ctx.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle: to,
          devMode: params.devMode,
          personalizationPrompt: await runtime.getPersonalizationPrompt(to),
          cliCommand: runtime.getTerminalOrchestrationCliCommand(to),
          ...(dispatchCapability ? { dispatchCapability } : {})
        })

        let injected = false
        if (params.inject) {
          try {
            await runtime.sendTerminalAgentPrompt(to, preamble)
            injected = true
          } catch (err) {
            db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
            throw err
          }
        }

        // Why: returnPreamble is opt-in because the preamble is several hundred bytes most callers don't need in the response.
        if (params.returnPreamble) {
          return { dispatch: ctx, injected, preamble }
        }
        return { dispatch: ctx, injected }
      })
    }
  }),

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)
      if (ctx?.assignee_handle) {
        // Why: --preamble re-mints the dispatch capability for the assignee, so
        // this reads out a secret that authorizes acting as that pane's worker.
        runtime.assertTerminalHandleInCallerScope(ctx.assignee_handle, 'dispatch assignee')
      }

      // Why: the preamble is derived from the current task spec, so it can be regenerated deterministically even after dispatch completes.
      if (params.preamble) {
        const task = db.getTask(params.task)
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        // Why here too: a task with no dispatch yet has no assignee to assert
        // above, and the preamble below still reads its spec out verbatim.
        createOrchestrationRowReach(db, runtime).assertTask(task)
        const workerHandle = ctx?.assignee_handle ?? 'worker'
        // Why (v10): the dcap_ plaintext died at mint (hash-only persistence),
        // so a regenerated preamble cannot replay it — re-mint instead. Safe
        // because this is the injection-failed recovery path: the prior token
        // never reached the worker, so rotating it strands nothing. Mint
        // rebinds pane/incarnation and clears revocation (relaunch semantics),
        // resolved exactly like the dispatch seam. When identity cannot be
        // resolved (or the dispatch is no longer active), fall back to a
        // flag-less preamble with an explicit caveat, never a silently broken one.
        let dispatchCapability: string | undefined
        let capabilityCaveat: string | undefined
        if (ctx?.capability_hash) {
          const paneKey = runtime.getTerminalPaneKey(workerHandle) ?? undefined
          const processIncarnation =
            runtime.getTerminalProcessIncarnation?.(workerHandle) ?? undefined
          if (paneKey && processIncarnation) {
            try {
              dispatchCapability = db.capabilities.mint({
                dispatchId: ctx.id,
                paneKey,
                processIncarnation
              })
            } catch (error) {
              if (!(error instanceof OrchestrationError) || error.code !== 'dispatch_inactive') {
                throw error
              }
              capabilityCaveat = `Dispatch ${ctx.id} is ${ctx.status}; regenerated the preamble without --dispatch-capability (re-mint needs an active dispatch).`
            }
          } else {
            capabilityCaveat = `Cannot resolve the pane/process identity of ${workerHandle}; regenerated the preamble without --dispatch-capability, so its lifecycle sends will be rejected.`
          }
        }
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Why: use the real ctx.id when present so the preview matches what was injected; placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle,
          devMode: params.devMode,
          personalizationPrompt: await runtime.getPersonalizationPrompt(
            ctx?.assignee_handle ?? undefined
          ),
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {}),
          ...(dispatchCapability ? { dispatchCapability } : {})
        })
        return {
          dispatch: ctx ?? null,
          preamble,
          ...(capabilityCaveat ? { capabilityCaveat } : {})
        }
      }

      return { dispatch: ctx ?? null }
    }
  }),

  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (params, { runtime, signal }) => {
      // Why: group addresses have no unambiguous answer semantics; rejecting avoids a silent timeout on a decision_gate no one subscribes to.
      if (isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send --type decision_gate for fan-out questions'
        )
      }

      runtime.assertTerminalHandleInCallerScope(params.to, 'question recipient')
      const db = runtime.getOrchestrationDb()
      if (params.task) {
        // Why: naming a task opens a decision gate that blocks it, so the task is
        // a second object this call acts on — bounded exactly like gateCreate.
        createOrchestrationRowReach(db, runtime).assertTaskId(params.task)
      }
      const from = params.from ?? 'unknown'
      // Why: echoed on every return so a clamped caller reports the budget actually waited, not the one it asked for.
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []

      // Why taskId rides the payload: Coordinator.handleDecisionGateMessage hard-rejects a
      // decision_gate whose payload has no taskId, so without this an ask never becomes a gate.
      const payload = JSON.stringify({
        question: params.question,
        options,
        ...(params.task ? { taskId: params.task } : {})
      })
      // Why: same remint-stable recipient identity as send — a decision gate must
      // still reach the pane if the addressed handle goes stale mid-ask (#9163).
      const recipientPaneKey =
        runtime.getTerminalPaneKey(params.to) ?? lastPersistedRecipientPaneKey(db, params.to)
      const outbound = db.insertMessage({
        from,
        to: params.to,
        subject: 'Question',
        body: params.question,
        type: 'decision_gate',
        payload,
        recipientPaneKey
      })
      // Why create the gate here rather than waiting for the coordinator tick: when `to`
      // names an orchestrator *agent* the message goes into its PTY and no coordinator ever
      // sees it, so the gate would never exist and the queue would show nothing waiting.
      // Stamped with the origin so resolving it can answer this exact ask.
      if (params.task) {
        db.createGate({
          taskId: params.task,
          question: params.question,
          options,
          originMessageId: outbound.id
        })
      }

      runtime.deliverPendingMessagesForHandle(params.to, recipientPaneKey)
      runtime.notifyMessageArrived(params.to, outbound.type, recipientPaneKey)

      const threadId = outbound.id
      const deadline = Date.now() + timeoutMs
      const afterSequence = outbound.sequence

      // Why: waitForMessage is handle-scoped, so re-query by thread each wake and bound by remaining budget so distractor messages can't loop forever.
      while (true) {
        const replies = db.getThreadMessagesFor(threadId, from, afterSequence)
        if (replies.length > 0) {
          const reply = replies[0]
          db.markAsRead([reply.id])
          return {
            answer: reply.body,
            messageId: reply.id,
            threadId,
            timedOut: false,
            timeoutMs
          }
        }
        if (signal?.aborted) {
          return { answer: null, messageId: null, threadId, timedOut: true, timeoutMs }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return { answer: null, messageId: null, threadId, timedOut: true, timeoutMs }
        }
        // Why: signal releases the waiter on client disconnect while the already-sent decision gate stays visible to the recipient.
        await runtime.waitForMessage(from, { timeoutMs: remainingMs, signal })
      }
    }
  }),

  ...ORCHESTRATION_GATE_METHODS,

  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      // Why: reset names no mailbox and wipes every pane's mail and tasks at
      // once, so there is nothing here to bound it to.
      assertLocalCallerScope(getCallerScope(), 'orchestration reset')
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      throw new Error('Invalid reset scope')
    }
  })
]
