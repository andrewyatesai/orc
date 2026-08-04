import { isOrcaYamlFieldWithinLimit } from './orca-yaml-file-limit'

/** A parsed `orca.yaml` mapping node, or null when the value is not a mapping. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A trimmed scalar field; undefined when absent, blank, or over the field cap. */
export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}
