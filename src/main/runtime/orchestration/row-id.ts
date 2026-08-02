import { randomBytes } from 'node:crypto'

// Ids stay `<prefix>_<hex>` (the shim owns generation, not Rust): orca-runtime.ts
// extracts task ids with `/task_[A-Za-z0-9]+/`, so the format is a contract.
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
