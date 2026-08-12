import type { SkillDiscoveryTarget } from '../../../shared/skills'

export function normalizeSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryTarget | undefined {
  const projectRuntime = target?.projectRuntime
  if (projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return { projectRuntime }
    }
    if (projectRuntime.runtime.kind === 'wsl') {
      return {
        runtime: 'wsl',
        wslDistro: projectRuntime.runtime.distro,
        projectRuntime
      }
    }
    return {
      runtime: 'host',
      projectRuntime
    }
  }

  if (target?.runtime !== 'wsl') {
    return undefined
  }
  return { runtime: 'wsl', wslDistro: target.wslDistro?.trim() || null }
}

export function getSkillDiscoveryTargetKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
}
