import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'

type UseAgentSkillSetupTerminalParams = {
  activeCommand: string
  mountedRef: MutableRefObject<boolean>
  refreshPreInstallNotice: () => Promise<void>
  offlineInstall?: () => Promise<boolean>
  onBeforeOpenTerminal?: () => void | Promise<void>
  onRecheck: () => void | Promise<unknown>
  freshnessSkillName?: string
}

type UseAgentSkillSetupTerminalResult = {
  terminalOpen: boolean
  terminalCommand: string | null
  terminalAttempt: number
  terminalOpening: boolean
  offlineInstalling: boolean
  setupAttemptRunning: boolean
  setupCommandFailedCode: number | null
  installBusy: boolean
  openSetupTerminal: () => void
  handleSetupCommandFinished: (bestEffortExitCode: number | null) => void
  handleTerminalExit: () => void
}

/**
 * Owns the inline setup-terminal lifecycle: opening (with the offline-first path),
 * the OSC 133;D command-outcome verdict, and the failed-attempt retry state. Kept
 * out of AgentSkillSetupPanel so the panel stays render-only.
 */
export function useAgentSkillSetupTerminal({
  activeCommand,
  mountedRef,
  refreshPreInstallNotice,
  offlineInstall,
  onBeforeOpenTerminal,
  onRecheck,
  freshnessSkillName
}: UseAgentSkillSetupTerminalParams): UseAgentSkillSetupTerminalResult {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [terminalAttempt, setTerminalAttempt] = useState(0)
  const [terminalOpening, setTerminalOpening] = useState(false)
  const [offlineInstalling, setOfflineInstalling] = useState(false)
  const [setupAttemptRunning, setSetupAttemptRunning] = useState(false)
  const [setupCommandFailedCode, setSetupCommandFailedCode] = useState<number | null>(null)
  const setupAttemptRunningRef = useRef(false)
  const installBusy = terminalOpening || offlineInstalling

  const openSetupTerminal = (): void => {
    if (installBusy || setupAttemptRunning) {
      return
    }
    const nextCommand =
      setupCommandFailedCode !== null && terminalCommand ? terminalCommand : activeCommand
    // Why: retire the failed terminal before the retry so its stale rows never
    // bleed into the fresh attempt.
    if (setupCommandFailedCode !== null) {
      setTerminalOpen(false)
    }
    if (offlineInstall) {
      setOfflineInstalling(true)
    } else {
      setTerminalOpening(true)
    }
    void (async () => {
      let shouldOpenTerminal = false
      try {
        if (offlineInstall && (await offlineInstall())) {
          await refreshPreInstallNotice()
          // Why: an offline retry that lands installs without ever finishing a
          // command in the shell, so clear the prior failure verdict directly.
          if (mountedRef.current) {
            setSetupCommandFailedCode(null)
          }
          return
        }
        if (mountedRef.current) {
          setOfflineInstalling(false)
          setTerminalOpening(true)
        }
        await onBeforeOpenTerminal?.()
        await refreshPreInstallNotice()
        shouldOpenTerminal = true
      } catch {
        shouldOpenTerminal = false
      } finally {
        if (mountedRef.current) {
          setOfflineInstalling(false)
          setTerminalOpening(false)
          if (shouldOpenTerminal) {
            setTerminalCommand(nextCommand)
            setTerminalAttempt((attempt) => attempt + 1)
            setTerminalOpen(true)
            setupAttemptRunningRef.current = true
            setSetupAttemptRunning(true)
          }
        }
      }
    })()
  }

  // Why: PTY exit is the shell's status; OSC 133;D reports the install command.
  const handleSetupCommandFinished = useCallback(
    (bestEffortExitCode: number | null): void => {
      // Nested shells can emit duplicate completion markers in one PTY chunk.
      if (!setupAttemptRunningRef.current) {
        return
      }
      setupAttemptRunningRef.current = false
      setSetupAttemptRunning(false)
      if (bestEffortExitCode !== null) {
        setSetupCommandFailedCode(bestEffortExitCode === 0 ? null : bestEffortExitCode)
      }
      if (freshnessSkillName) {
        notifyInstalledAgentSkillsChanged()
      }
      void onRecheck()
    },
    [freshnessSkillName, onRecheck]
  )

  const handleTerminalExit = useCallback((): void => {
    if (mountedRef.current) {
      setupAttemptRunningRef.current = false
      setTerminalOpen(false)
      setSetupAttemptRunning(false)
    }
    notifyInstalledAgentSkillsChanged()
  }, [mountedRef])

  return {
    terminalOpen,
    terminalCommand,
    terminalAttempt,
    terminalOpening,
    offlineInstalling,
    setupAttemptRunning,
    setupCommandFailedCode,
    installBusy,
    openSetupTerminal,
    handleSetupCommandFinished,
    handleTerminalExit
  }
}
