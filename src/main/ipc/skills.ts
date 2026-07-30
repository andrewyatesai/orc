import { app, BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import type {
  SkillFreshnessInventory,
  SkillUpdateRun,
  SkillUpdateStartResult
} from '../../shared/skill-freshness'
import { inventorySkillFreshness } from '../skills/skill-freshness-inventory'
import { SkillUpdateRunner } from '../skills/skill-update-run'
import { skillUpdateFailedNames } from '../skills/skill-update-outcome'
import { readGloballyUpdatableSkillLocks } from '../skills/skill-update-registration'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

export function registerSkillsHandlers(store: Store): void {
  const scanInventory = (): Promise<SkillFreshnessInventory> =>
    // Why: the update command targets this machine's global homes. WSL and SSH
    // inventories stay out until their installer rail has an equivalent proof.
    inventorySkillFreshness({
      currentAppVersion: app.getVersion(),
      repos: store.getRepos()
    })

  const runner = new SkillUpdateRunner({
    // Why: per-skill outcomes come from re-hashing what is actually on disk, not
    // from scraping stdout.
    rescanOutdatedNames: async (names) => {
      // The lock read is fresh on purpose: the run just rewrote it, and the
      // verdict accepts unrecognized content only when disk matches that record.
      const [inventory, globalSkillLocks] = await Promise.all([
        scanInventory(),
        readGloballyUpdatableSkillLocks()
      ])
      return skillUpdateFailedNames(names, inventory.installations, globalSkillLocks)
    },
    onState: (run: SkillUpdateRun) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('skills:updateRun', run)
        }
      }
    }
  })

  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      // Why: on a remote Orca runtime the skill files live on the server — proxy to its RPC so discovery
      // scans the right filesystem; on failure surface no skills rather than a mislabeling local scan.
      const environmentId = store.getSettings().activeRuntimeEnvironmentId?.trim()
      if (environmentId) {
        try {
          const response = await callRuntimeEnvironment(
            app.getPath('userData'),
            environmentId,
            'skills.discover',
            { cwd: target?.cwd ?? null },
            15_000
          )
          if (response.ok) {
            return response.result as SkillDiscoveryResult
          }
          console.warn('[skills] remote discovery failed:', response.error.message)
        } catch (error) {
          // Why: an unreachable host rejects rather than resolving ok:false.
          console.warn('[skills] remote discovery unavailable:', error)
        }
        return { skills: [], sources: [], scannedAt: Date.now() }
      }
      const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
      return discoverSkillsOnTarget(resolveSkillDiscoveryTarget(parsedTarget), store.getRepos())
    }
  )

  ipcMain.handle('skills:freshnessInventory', async (): Promise<SkillFreshnessInventory> => {
    return scanInventory()
  })

  ipcMain.handle(
    'skills:startUpdateRun',
    async (_event, names: string[]): Promise<SkillUpdateStartResult> => {
      return runner.start(Array.isArray(names) ? names : [])
    }
  )

  ipcMain.handle('skills:cancelUpdateRun', async (): Promise<void> => {
    runner.cancel()
  })

  ipcMain.handle('skills:acknowledgeUpdateRun', async (): Promise<void> => {
    runner.acknowledge()
  })

  ipcMain.handle('skills:getUpdateRun', async (): Promise<SkillUpdateRun> => {
    return runner.getState()
  })
}
