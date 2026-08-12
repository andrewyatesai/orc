import { z } from 'zod'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'

export type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

export type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

const nodePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
] satisfies NodeJS.Platform[])

const aiVaultSessionPreviewMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  text: z.string(),
  timestamp: z.string().nullable()
})

const executionHostIdSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeExecutionHostId(value)
  if (normalized) {
    return normalized
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Invalid execution host id'
  })
  return z.NEVER
})

// Relaxed from z.enum(AI_VAULT_AGENTS): a paired host on a NEWER build may report
// an agent this build's enum doesn't list yet. Accept any non-empty string so its
// sessions still surface (label/id lookups degrade gracefully) instead of nuking
// the whole batch. The transform re-types without validating membership.
const aiVaultAgentSchema = z.string().min(1).transform((value) => value as AiVaultAgent)

const aiVaultSessionSchema = z.object({
  id: z.string(),
  executionHostId: executionHostIdSchema,
  executionHostPlatform: nodePlatformSchema.nullable().optional(),
  agent: aiVaultAgentSchema,
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  model: z.string().nullable(),
  filePath: z.string(),
  codexHome: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  modifiedAt: z.string(),
  messageCount: z.number(),
  totalTokens: z.number(),
  previewMessages: z.array(aiVaultSessionPreviewMessageSchema),
  // Optional keeps paired hosts on older builds compatible.
  lastUserPrompt: z.string().nullable().optional(),
  // Default keeps remote hosts running an older build (no recoverable-signal
  // fields) parseable; they simply report no recoverable-empty sessions.
  queuedMessageCount: z.number().default(0),
  subagentTranscriptCount: z.number().default(0),
  resumeCommand: z.string(),
  // The default keeps remote hosts running an older build (no subagent
  // field) parseable; scanned top-level sessions carry null anyway.
  subagent: z
    .object({
      parentSessionId: z.string(),
      agentType: z.string().nullable(),
      status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable()
    })
    .nullable()
    .default(null)
})

const aiVaultScanIssueSchema = z.object({
  executionHostId: executionHostIdSchema.optional(),
  agent: aiVaultAgentSchema,
  path: z.string(),
  message: z.string()
})

// Validate the envelope shape once, then parse each row on its own: a single
// malformed session/issue is dropped instead of discarding the whole batch.
const aiVaultListResultEnvelopeSchema = z.object({
  sessions: z.array(z.unknown()),
  issues: z.array(z.unknown()),
  scannedAt: z.string()
})

type RuntimeAiVaultParseOutcome =
  | { ok: true; result: AiVaultListResult }
  | { ok: false; message: string }

// Per-row tolerance: unknown-agent and single-bad-row inputs keep their siblings
// instead of collapsing to an error result.
export function parseRuntimeAiVaultListResult(raw: unknown): RuntimeAiVaultParseOutcome {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return { ok: false, message: envelope.error.issues[0]?.message ?? 'unexpected result shape' }
  }
  const sessions: AiVaultSession[] = []
  for (const row of envelope.data.sessions) {
    const parsed = aiVaultSessionSchema.safeParse(row)
    if (parsed.success) {
      sessions.push(parsed.data)
    }
  }
  const issues: AiVaultScanIssue[] = []
  for (const row of envelope.data.issues) {
    const parsed = aiVaultScanIssueSchema.safeParse(row)
    if (parsed.success) {
      issues.push(parsed.data)
    }
  }
  return { ok: true, result: { sessions, issues, scannedAt: envelope.data.scannedAt } }
}

// Why: zod strips unknown keys, so the repin home must be declared or the
// parent would silently drop it and resume under the wrong account's home.
const aiVaultPrepareSessionResumeResultSchema = z.object({
  useRealCodexHome: z.boolean(),
  substituteCodexHome: z.string().optional()
})

export function getSavedRuntimeAiVaultHostInfos(
  userDataPath: string
): readonly RuntimeAiVaultHostInfo[] {
  return listEnvironments(userDataPath).map((environment) => ({
    environmentId: environment.id,
    executionHostId: toRuntimeExecutionHostId(environment.id)
  }))
}

export async function scanRuntimeAiVaultSessions(
  userDataPath: string,
  environmentId: string,
  args: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.listSessions',
    {
      limit: args.limit,
      unlimited: args.unlimited,
      force: args.force,
      // Why: cap here so the set of scanned paths is explicit on this side —
      // the RPC schema CLAMPS to the same bound anyway (older hosts had no
      // cap). Dropped paths only lose the older-than-recency-cap guarantee,
      // never the recent sessions themselves.
      scopePaths: args.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT),
      executionHostId
    },
    options.timeoutMs
  )
  if (response.ok === true) {
    const parsed = parseRuntimeAiVaultListResult(response.result)
    if (parsed.ok) {
      return withRuntimeExecutionHost(parsed.result, executionHostId)
    }
    return runtimeScanIssueResult({
      executionHostId,
      environmentId,
      message: `Invalid aiVault.listSessions response: ${parsed.message}`
    })
  }
  return runtimeScanIssueResult({
    executionHostId,
    environmentId,
    message: response.error.message
  })
}

export async function prepareRuntimeAiVaultSessionResume(
  userDataPath: string,
  environmentId: string,
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.prepareSessionResume',
    args
  )
  if (response.ok !== true) {
    throw new Error(response.error.message)
  }
  const parsed = aiVaultPrepareSessionResumeResultSchema.safeParse(response.result)
  if (!parsed.success) {
    throw new Error(
      `Invalid aiVault.prepareSessionResume response: ${parsed.error.issues[0]?.message ?? 'unexpected result shape'}`
    )
  }
  return parsed.data
}

function withRuntimeExecutionHost(
  result: AiVaultListResult,
  executionHostId: `runtime:${string}`
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) => retagRuntimeSession(session, executionHostId)),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt
  }
}

function retagRuntimeSession(
  session: AiVaultSession,
  executionHostId: `runtime:${string}`
): AiVaultSession {
  // The paired server is the transport, but the parent owns which concrete
  // runtime host was scanned; never trust returned host ids across the boundary.
  return {
    ...session,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}

function runtimeScanIssueResult(args: {
  executionHostId: `runtime:${string}`
  environmentId: string
  message: string
}): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId: args.executionHostId,
        agent: 'codex',
        path: args.environmentId,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
