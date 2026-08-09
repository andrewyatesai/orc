// Why no ORCA_PANE_KEY / ORCA_WORKTREE_ID / ORCA_TERMINAL_HANDLE /
// ORCA_WORKSPACE_ID here: those are pane authority on the host, and this env
// belongs to the remote account. They travel instead as the relay's own
// attribution of the calling pane (orca-cli-pane-attribution.ts), so there is
// nothing for the host to import — or for a caller to forge.
export function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of ['ORCA_USER_DATA_PATH', 'PATH', 'Path']) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
