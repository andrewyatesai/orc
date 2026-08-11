/* eslint-disable max-lines -- Why: Linear credential storage and client
   selection share one module so keychain-safe status reads and token mutation
   stay in one consistency boundary. */
import type { LinearClient } from '@linear/sdk'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadLinearSdk, type LinearSdkModule } from './linear-sdk'
import {
  CredentialDecryptionError,
  type CredentialPersistOutcome,
  readStoredCredentialTokenFile,
  removeStoredCredentialToken,
  storedCredentialExists,
  writeStoredCredentialToken
} from '../integration-credential-file'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../shared/types'

// ── Lazy @linear/sdk ─────────────────────────────────────────────────
// Why: the SDK is a ~2.6 MB CJS bundle only needed to build a client for real
// API calls (never at startup — initLinearToken warms plaintext metadata only),
// so it stays OUT of the every-launch main-bundle parse. Loading goes through
// ./linear-sdk's createRequire accessor, which caches and stays mockable in
// tests. The async wrapper is the call-site contract for the client factories.
let sdk: LinearSdkModule | null = null
export async function ensureLinearSdk(): Promise<LinearSdkModule> {
  sdk ??= loadLinearSdk()
  return sdk
}

// ── Concurrency limiter — max 4 parallel Linear API calls ────────────
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

// ── Token + workspace storage ────────────────────────────────────────
// Why: tokens remain encrypted via safeStorage, while workspace metadata stays
// plaintext so status checks can render connected accounts without decrypting
// and triggering OS keychain prompts after app updates.
const LEGACY_WORKSPACE_ID = 'legacy'

type LinearWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: LinearWorkspaceSelection | null
  workspaces: LinearWorkspace[]
}

export type LinearClientForWorkspace = {
  workspace: LinearWorkspace
  client: LinearClient
  apiKey: string
}

export const LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS = 60 * 60

let cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per workspace so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()
let cachedLegacyViewer: LinearViewer | null = null
let legacyViewerLoadedFromDisk = false
let cachedWorkspaceFile: LinearWorkspaceFile | null = null
let workspaceFileLoadedFromDisk = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getLegacyTokenPath(): string {
  return join(getOrcaDir(), 'linear-token.enc')
}

function getLegacyViewerPath(): string {
  return join(getOrcaDir(), 'linear-viewer.json')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'linear-workspaces.json')
}

function getWorkspaceTokenDir(): string {
  return join(getOrcaDir(), 'linear-tokens')
}

function getWorkspaceTokenPath(workspaceId: string): string {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return getLegacyTokenPath()
  }
  return join(getWorkspaceTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureWorkspaceTokenDir(): void {
  const dir = getWorkspaceTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function readLegacyViewerFromDisk(): LinearViewer | null {
  const path = getLegacyViewerPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearViewer>
    if (typeof parsed?.displayName !== 'string' || typeof parsed?.organizationName !== 'string') {
      return null
    }
    return {
      displayName: parsed.displayName,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      organizationId: typeof parsed.organizationId === 'string' ? parsed.organizationId : undefined,
      organizationName: parsed.organizationName,
      organizationUrlKey:
        typeof parsed.organizationUrlKey === 'string' ? parsed.organizationUrlKey : undefined
    }
  } catch {
    return null
  }
}

function getLegacyViewer(): LinearViewer | null {
  if (!legacyViewerLoadedFromDisk) {
    cachedLegacyViewer = readLegacyViewerFromDisk()
    legacyViewerLoadedFromDisk = true
  }
  return cachedLegacyViewer
}

function normalizeWorkspace(input: unknown): LinearWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.organizationName !== 'string') {
    return null
  }
  if (typeof record.displayName !== 'string') {
    return null
  }

  const organizationId =
    typeof record.organizationId === 'string' && record.organizationId
      ? record.organizationId
      : record.id

  return {
    id: record.id,
    organizationId,
    organizationName: record.organizationName,
    organizationUrlKey:
      typeof record.organizationUrlKey === 'string' ? record.organizationUrlKey : undefined,
    displayName: record.displayName,
    email: typeof record.email === 'string' ? record.email : null,
    credentialRevision:
      typeof record.credentialRevision === 'number' && Number.isFinite(record.credentialRevision)
        ? record.credentialRevision
        : undefined
  }
}

function emptyWorkspaceFile(): LinearWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

function readWorkspaceFileFromDisk(): LinearWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is LinearWorkspace => workspace !== null)
          .filter((workspace) => hasStoredToken(workspace.id))
      : []
    const activeWorkspaceId =
      typeof parsed.activeWorkspaceId === 'string' &&
      workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : (workspaces[0]?.id ?? null)
    const selectedWorkspaceId =
      parsed.selectedWorkspaceId === 'all' ||
      (typeof parsed.selectedWorkspaceId === 'string' &&
        workspaces.some((workspace) => workspace.id === parsed.selectedWorkspaceId))
        ? parsed.selectedWorkspaceId
        : activeWorkspaceId

    return {
      version: 1,
      activeWorkspaceId,
      selectedWorkspaceId,
      workspaces
    }
  } catch {
    return emptyWorkspaceFile()
  }
}

function getWorkspaceFile(): LinearWorkspaceFile {
  if (!workspaceFileLoadedFromDisk || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoadedFromDisk = true
  }
  return cachedWorkspaceFile
}

function writeWorkspaceFile(file: LinearWorkspaceFile): void {
  ensureOrcaDir()
  const persistedWorkspaces = file.workspaces.filter(
    (workspace) => workspace.id !== LEGACY_WORKSPACE_ID
  )
  const selectableIds = new Set(persistedWorkspaces.map((workspace) => workspace.id))
  if (hasStoredToken(LEGACY_WORKSPACE_ID)) {
    selectableIds.add(LEGACY_WORKSPACE_ID)
  }
  const activeWorkspaceId =
    file.activeWorkspaceId && selectableIds.has(file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (persistedWorkspaces[0]?.id ??
        (selectableIds.has(LEGACY_WORKSPACE_ID) ? LEGACY_WORKSPACE_ID : null))
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId && selectableIds.has(file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  cachedWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces: persistedWorkspaces
  }
  workspaceFileLoadedFromDisk = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function getLegacyWorkspace(): LinearWorkspace | null {
  if (!hasStoredToken(LEGACY_WORKSPACE_ID)) {
    return null
  }
  const viewer = getLegacyViewer()
  return {
    id: LEGACY_WORKSPACE_ID,
    organizationId: viewer?.organizationId ?? LEGACY_WORKSPACE_ID,
    organizationName: viewer?.organizationName ?? 'Saved Linear workspace',
    organizationUrlKey: viewer?.organizationUrlKey,
    displayName: viewer?.displayName ?? 'Linear API key',
    email: viewer?.email ?? null,
    isLegacy: true
  }
}

function getWorkspaceState(): LinearWorkspaceFile {
  const file = getWorkspaceFile()
  const legacyWorkspace = getLegacyWorkspace()
  const workspaces = [
    ...(legacyWorkspace ? [legacyWorkspace] : []),
    ...file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  ]
  const activeWorkspaceId =
    file.activeWorkspaceId &&
    workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (workspaces[0]?.id ?? null)
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId &&
          workspaces.some((workspace) => workspace.id === file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  return {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
}

function clearLegacyViewerOnDisk(): void {
  try {
    unlinkSync(getLegacyViewerPath())
  } catch {
    // File may not exist — safe to ignore.
  }
}

// Why the key stays cached even when nothing was written: without a keychain the write is refused,
// and the in-memory copy is what keeps this session connected until the user reconnects after restart.
// Why the outcome is returned: a caller that then DELETES another copy of the credential must be able
// to tell whether this one actually reached disk.
function saveWorkspaceToken(workspaceId: string, apiKey: string): CredentialPersistOutcome {
  ensureOrcaDir()
  if (workspaceId !== LEGACY_WORKSPACE_ID) {
    ensureWorkspaceTokenDir()
  }
  const outcome = writeStoredCredentialToken('Linear', getWorkspaceTokenPath(workspaceId), apiKey)
  cachedTokens.set(workspaceId, apiKey)
  credentialErrors.delete(workspaceId)
  return outcome
}

// Backward-compatible export for the legacy single-workspace storage path.
export function saveToken(apiKey: string): void {
  saveWorkspaceToken(LEGACY_WORKSPACE_ID, apiKey)
}

export function loadToken(options: { force?: boolean; workspaceId?: string } = {}): string | null {
  const workspaceId = options.workspaceId ?? resolveWorkspaceId()
  if (!workspaceId) {
    return null
  }
  const cached = cachedTokens.get(workspaceId)
  if (cached !== undefined) {
    return cached
  }
  if (!options.force) {
    return null
  }
  try {
    const token = readStoredCredentialTokenFile('Linear', getWorkspaceTokenPath(workspaceId))
    if (token) {
      cachedTokens.set(workspaceId, token)
      credentialErrors.delete(workspaceId)
    }
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(workspaceId, error.message)
      throw error
    }
    return null
  }
}

export function hasStoredToken(workspaceId?: string): boolean {
  if (!workspaceId) {
    return getWorkspaceState().workspaces.length > 0
  }
  if (cachedTokens.has(workspaceId)) {
    return true
  }
  return storedCredentialExists(getWorkspaceTokenPath(workspaceId))
}

function clearTokenFile(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  credentialErrors.delete(workspaceId)
  removeStoredCredentialToken(getWorkspaceTokenPath(workspaceId))
}

export function clearToken(workspaceId?: string): void {
  if (!workspaceId) {
    const state = getWorkspaceState()
    for (const workspace of state.workspaces) {
      clearTokenFile(workspace.id)
    }
    cachedTokens = new Map()
    credentialErrors.clear()
    cachedLegacyViewer = null
    legacyViewerLoadedFromDisk = false
    cachedWorkspaceFile = emptyWorkspaceFile()
    workspaceFileLoadedFromDisk = true
    clearLegacyViewerOnDisk()
    writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  clearTokenFile(workspaceId)
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    cachedLegacyViewer = null
    legacyViewerLoadedFromDisk = false
    clearLegacyViewerOnDisk()
    return
  }

  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const activeWorkspaceId =
    file.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : file.activeWorkspaceId
  const selectedWorkspaceId =
    file.selectedWorkspaceId === workspaceId ? activeWorkspaceId : file.selectedWorkspaceId
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  })
}

function workspaceFromLinearData(
  me: { displayName: string; email?: string | null },
  org: { id: string; name: string; urlKey?: string | null }
): LinearWorkspace {
  return {
    id: org.id,
    organizationId: org.id,
    organizationName: org.name,
    organizationUrlKey: org.urlKey ?? undefined,
    displayName: me.displayName,
    email: me.email ?? null
  }
}

function upsertWorkspace(workspace: LinearWorkspace, options: { select?: boolean } = {}): void {
  const file = getWorkspaceFile()
  const current = file.workspaces.find((entry) => entry.id === workspace.id)
  const credentialRevision = (current?.credentialRevision ?? 0) + 1
  const workspaceWithRevision = { ...workspace, credentialRevision }
  const withoutCurrent = file.workspaces.filter((entry) => entry.id !== workspace.id)
  const workspaces = [...withoutCurrent, workspaceWithRevision].sort((a, b) =>
    a.organizationName.localeCompare(b.organizationName)
  )
  const selectedWorkspaceId = options.select
    ? workspace.id
    : file.selectedWorkspaceId && file.selectedWorkspaceId !== LEGACY_WORKSPACE_ID
      ? file.selectedWorkspaceId
      : workspace.id
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspace.id,
    selectedWorkspaceId,
    workspaces
  })
}

/**
 * Migrates the single legacy API key onto its real workspace, and returns the workspace actually in
 * effect. The migration moves the SAME token from one path to another, so it is abandoned when the
 * new copy could not be written: deleting the legacy file would then leave zero persisted copies and
 * log the user out at the next launch with nothing to recover.
 */
function replaceLegacyWorkspace(workspace: LinearWorkspace, token: string): LinearWorkspace {
  if (saveWorkspaceToken(workspace.id, token) === 'memory-only') {
    console.warn(
      '[linear] safeStorage unavailable — keeping the legacy Linear API key on disk instead of migrating it, so the workspace is still connected after a restart.'
    )
    return { ...workspace, id: LEGACY_WORKSPACE_ID, isLegacy: true }
  }
  clearTokenFile(LEGACY_WORKSPACE_ID)
  clearLegacyViewerOnDisk()
  cachedLegacyViewer = null
  legacyViewerLoadedFromDisk = true
  upsertWorkspace(workspace, { select: true })
  return workspace
}

function resolveWorkspaceId(workspaceId?: string | null): string | null {
  if (workspaceId && workspaceId !== 'all') {
    return workspaceId
  }
  const state = getWorkspaceState()
  if (
    state.selectedWorkspaceId &&
    state.selectedWorkspaceId !== 'all' &&
    state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)
  ) {
    return state.selectedWorkspaceId
  }
  if (
    state.activeWorkspaceId &&
    state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
  ) {
    return state.activeWorkspaceId
  }
  return state.workspaces[0]?.id ?? null
}

// ── Client factory ───────────────────────────────────────────────────
// Why: issues/teams modules call this for real Linear actions — at that point
// decrypting the token and surfacing a keychain prompt is expected.
export async function getClient(workspaceId?: string | null): Promise<LinearClient | null> {
  const token = loadToken({
    force: true,
    workspaceId: resolveWorkspaceId(workspaceId) ?? undefined
  })
  if (!token) {
    return null
  }
  const { LinearClient } = await ensureLinearSdk()
  return new LinearClient({ apiKey: token })
}

export async function getClients(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearClientForWorkspace[]> {
  const { LinearClient } = await ensureLinearSdk()
  const state = getWorkspaceState()
  const isAllSelection = workspaceId === 'all'
  const selectedWorkspaces = isAllSelection
    ? state.workspaces
    : state.workspaces.filter((workspace) => workspace.id === resolveWorkspaceId(workspaceId))

  const clients: LinearClientForWorkspace[] = []
  for (const workspace of selectedWorkspaces) {
    let token: string | null
    try {
      token = loadToken({ force: true, workspaceId: workspace.id })
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable workspace must not
      // collapse reads for the healthy ones. loadToken already recorded the
      // per-workspace credentialError for getStatus to surface, so skip this
      // workspace like a missing token. A specific-workspace selection still
      // rethrows so the renderer can surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        continue
      }
      throw error
    }
    if (!token) {
      continue
    }
    clients.push({
      workspace,
      client: new LinearClient({ apiKey: token }),
      apiKey: token
    })
  }
  return clients
}

export async function getPublicFileUrlClient(
  entry: LinearClientForWorkspace
): Promise<LinearClient> {
  const { LinearClient } = await ensureLinearSdk()
  return new LinearClient({
    apiKey: entry.apiKey,
    headers: {
      'public-file-urls-expire-in': String(LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
    }
  })
}

// ── Auth error detection ─────────────────────────────────────────────
// Why: 401 errors must trigger token clearing and a re-auth prompt in the
// renderer. All other errors are swallowed with console.warn to match GitHub
// client's graceful degradation.
export function isAuthError(error: unknown): boolean {
  // Reads the cached SDK class: isAuthError only runs inside a catch AFTER an
  // API op already loaded the SDK, so `sdk` is set. Before any op it is null
  // (no client was ever built, so no AuthenticationLinearError can exist) —
  // don't force the SDK parse just to classify an error.
  return sdk != null && error instanceof sdk.AuthenticationLinearError
}

// ── Connect / disconnect / status ────────────────────────────────────
export async function connect(
  apiKey: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  try {
    const { LinearClient } = await ensureLinearSdk()
    const client = new LinearClient({ apiKey })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)

    const outcome = saveWorkspaceToken(workspace.id, apiKey)
    const legacyWorkspace = getLegacyWorkspace()
    if (
      legacyWorkspace &&
      legacyWorkspace.organizationName === workspace.organizationName &&
      legacyWorkspace.email === workspace.email
    ) {
      // Why the outcome gates the de-duplication: with no keychain the new key was not written, so
      // dropping the legacy copy of the same account would log the user out at the next launch. The
      // duplicate row that survives for this session is the cheaper of the two costs.
      if (outcome === 'memory-only') {
        console.warn(
          '[linear] safeStorage unavailable — keeping the previously saved Linear API key for this account on disk; the new key is active for this session only.'
        )
      } else {
        clearTokenFile(LEGACY_WORKSPACE_ID)
        clearLegacyViewerOnDisk()
        cachedLegacyViewer = null
        legacyViewerLoadedFromDisk = true
      }
    }
    upsertWorkspace(workspace, { select: true })
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export function disconnect(workspaceId?: string): void {
  clearToken(workspaceId)
}

export function selectWorkspace(workspaceId: LinearWorkspaceSelection): LinearConnectionStatus {
  const state = getWorkspaceState()
  if (
    workspaceId !== 'all' &&
    !state.workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    return getStatus()
  }

  const file = getWorkspaceFile()
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId,
    workspaces: file.workspaces
  })
  return getStatus()
}

export function getStatus(): LinearConnectionStatus {
  const state = getWorkspaceState()
  const selectedWorkspace =
    state.selectedWorkspaceId && state.selectedWorkspaceId !== 'all'
      ? state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
      : null
  const activeWorkspace =
    selectedWorkspace ??
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0] ??
    null

  const credentialError = state.workspaces
    .map((workspace) => credentialErrors.get(workspace.id))
    .find((message) => message !== undefined)

  return {
    connected: state.workspaces.length > 0,
    viewer: activeWorkspace,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function testConnection(
  workspaceId?: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  const resolvedWorkspaceId = resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return { ok: false, error: 'No API key stored.' }
  }
  let token: string | null
  try {
    token = loadToken({ force: true, workspaceId: resolvedWorkspaceId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
  if (!token) {
    return { ok: false, error: 'No API key stored.' }
  }

  try {
    const { LinearClient } = await ensureLinearSdk()
    const client = new LinearClient({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)
    // Why the returned workspace can differ: an abandoned legacy migration keeps the legacy id, and
    // handing the renderer the un-migrated id would select a workspace that is not in the status list.
    let effectiveWorkspace = workspace
    if (resolvedWorkspaceId === LEGACY_WORKSPACE_ID) {
      effectiveWorkspace = replaceLegacyWorkspace(workspace, token)
    } else {
      saveWorkspaceToken(workspace.id, token)
      upsertWorkspace(workspace, { select: true })
    }
    return { ok: true, viewer: effectiveWorkspace, workspace: effectiveWorkspace }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(resolvedWorkspaceId)
    }
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
}

// Why: called at main-process startup. We warm plaintext metadata only; tokens
// stay encrypted on disk until a user performs an actual Linear action.
export function initLinearToken(): void {
  getWorkspaceFile()
  getLegacyViewer()
}
