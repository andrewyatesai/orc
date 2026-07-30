import type { ExecutionHostId } from './execution-host'
import type { KeybindingFileSnapshot } from './keybindings'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type {
  BrowserSessionProfile,
  FolderWorkspace,
  GlobalSettings,
  OnboardingState,
  PersistedUIState,
  Project,
  ProjectGroup,
  ProjectHostSetup,
  Repo,
  WorkspaceSessionState
} from './types'

export const STARTUP_SNAPSHOT_CHANNEL = 'startup:getSnapshot'

/** One-invoke boot payload: every read the renderer startup chain needs, taken
 *  from main's in-memory stores in a single atomic pass so hydration sees a
 *  consistent snapshot instead of paying one IPC round-trip per read.
 *
 *  Every field is optional: a missing piece means "this snapshot source was
 *  unavailable" and the renderer falls back to that piece's individual channel,
 *  which stays registered for non-boot callers. */
export type StartupSnapshot = {
  settings?: GlobalSettings
  ui?: PersistedUIState
  keybindings?: KeybindingFileSnapshot
  onboarding?: OnboardingState
  /** Catalog reads (informational until the catalog slices adopt them): the
   *  boot chain still calls repos:list etc. so promotion/enrichment side
   *  effects keep running exactly once there. */
  repos?: Repo[]
  projects?: Project[]
  projectHostSetups?: ProjectHostSetup[]
  projectGroups?: ProjectGroup[]
  folderWorkspaces?: FolderWorkspace[]
  runtimeEnvironments?: PublicKnownRuntimeEnvironment[]
  /** Local + known runtime-host workspace session partitions. Unknown hosts
   *  (e.g. discovered later from the repo catalog) fall back to session:get. */
  sessionPartitionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  /** Only included for the trusted main-window renderer, mirroring the
   *  browser:session:listProfiles sender gate. */
  browserSessionProfiles?: BrowserSessionProfile[]
}
