// Why: a per-method guard on a surface this size is a checklist that goes stale
// the next time somebody adds a method — three review rounds each found a group
// nobody had listed. So the bound rides REGISTRATION: every group in
// ALL_RPC_METHODS is wrapped on the way in, and staying unwrapped costs an
// explicit, named policy with a reason. A group added next month is bounded on
// the day it lands, and an exemption is a line in a diff instead of an omission.
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { assertLocalCallerScope, getCallerScope } from '../../runtime-caller-scope'

export type RpcMethodGroups = Readonly<Record<string, readonly RpcAnyMethod[]>>

type GroupGuard = (name: string, params: unknown, ctx: RpcContext) => void | Promise<void>

declare const CALLER_SCOPE_BOUND: unique symbol

/**
 * Only {@link bindRpcMethodGroupsToCallerScope} mints these, so `[...FOO_METHODS]`
 * spread into the registry beside them is a type error rather than a raw group
 * nobody notices — the `emulator.*` failure mode, made uncompilable.
 */
export type CallerScopeBoundMethod = RpcAnyMethod & { readonly [CALLER_SCOPE_BOUND]: true }

export type RpcMethodGroupPolicy =
  /** Not wrapped: the group carries its own bound, or reaches nothing a host owns. */
  | { readonly kind: 'exempt'; readonly why: string }
  /** Wrapped by a guard of its own instead of the local-only default. */
  | { readonly kind: 'guard'; readonly why: string; readonly guard: GroupGuard }

/** Keyed by group name, so an exemption for a renamed group stops compiling. */
export type RpcMethodGroupPolicies<TGroups extends RpcMethodGroups> = Partial<
  Record<keyof TGroups, RpcMethodGroupPolicy>
>

export function callerScopeExempt(why: string): RpcMethodGroupPolicy {
  return { kind: 'exempt', why }
}

export function callerScopeGuardedBy(guard: GroupGuard, why: string): RpcMethodGroupPolicy {
  return { kind: 'guard', why, guard }
}

function withGroupGuard(
  methods: readonly RpcAnyMethod[],
  guard: GroupGuard
): readonly CallerScopeBoundMethod[] {
  return methods.map((method) => {
    if (isStreamingMethod(method)) {
      return {
        ...method,
        handler: async (params: unknown, ctx: RpcContext, emit: (result: unknown) => void) => {
          await guard(method.name, params, ctx)
          return method.handler(params, ctx, emit)
        }
      } as CallerScopeBoundMethod
    }
    return {
      ...method,
      handler: async (params: unknown, ctx: RpcContext) => {
        await guard(method.name, params, ctx)
        return method.handler(params, ctx)
      }
    } as CallerScopeBoundMethod
  })
}

/**
 * The default every unlisted group gets: no host selector is known to exist, so
 * the command drives whatever machine the app runs on and only a local caller
 * may issue it.
 */
const localOnlyGuard: GroupGuard = (name) => {
  assertLocalCallerScope(getCallerScope(), name)
}

/**
 * Arbitrary code in the user's logged-in browser profile — no worktree makes
 * that safe for a caller on another machine, so these stay local-only.
 */
const NO_HOST_CAN_BOUND_THESE = new Set(['browser.eval', 'browser.exec'])

/**
 * Browser commands do have a host selector — the worktree whose session they
 * drive — so the group is bounded to that target rather than refused outright.
 */
export const browserCallerScopeGuard: GroupGuard = async (name, params, ctx) => {
  if (getCallerScope().kind === 'local') {
    return
  }
  if (NO_HOST_CAN_BOUND_THESE.has(name)) {
    assertLocalCallerScope(getCallerScope(), name)
  }
  const worktree = (params as { worktree?: unknown } | undefined)?.worktree
  await ctx.runtime.assertBrowserTargetInCallerScope(
    typeof worktree === 'string' && worktree.length > 0 ? worktree : undefined
  )
}

/**
 * Wraps every group, then hands back one flat registry. Absence of a policy is
 * the safe answer, not a silent pass: an unlisted group is local-only.
 */
export function bindRpcMethodGroupsToCallerScope<TGroups extends RpcMethodGroups>(
  groups: TGroups,
  policies: RpcMethodGroupPolicies<TGroups>
): readonly CallerScopeBoundMethod[] {
  for (const [name, policy] of Object.entries(policies)) {
    // Why at startup: a policy whose group was renamed or deleted would otherwise
    // keep reading as a decision somebody made about this registry.
    if (!Object.hasOwn(groups, name)) {
      throw new Error(`rpc_caller_scope_policy_for_unknown_group:${name}`)
    }
    if ((policy?.why ?? '').trim().length === 0) {
      throw new Error(`rpc_caller_scope_policy_needs_reason:${name}`)
    }
  }
  const bound: CallerScopeBoundMethod[] = []
  for (const [name, methods] of Object.entries(groups)) {
    // Why: an empty group means an import that resolved to nothing, which would
    // register no methods and look identical to a group nobody uses.
    if (methods.length === 0) {
      throw new Error(`rpc_method_group_empty:${name}`)
    }
    const policy = policies[name as keyof TGroups]
    if (policy?.kind === 'exempt') {
      // The brand says "passed through here", not "wrapped" — an exemption is a
      // decision recorded above, and the group keeps its own method objects.
      bound.push(...(methods as readonly CallerScopeBoundMethod[]))
      continue
    }
    bound.push(...withGroupGuard(methods, policy?.kind === 'guard' ? policy.guard : localOnlyGuard))
  }
  return bound
}
