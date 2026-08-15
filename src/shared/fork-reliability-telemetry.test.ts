import { describe, expect, it } from 'vitest'
import {
  DAEMON_DEGRADED_FALLBACK_REASONS,
  DAEMON_LAUNCH_FAILURE_CLASSES,
  GIT_WASM_UNAVAILABLE_CLASSES,
  RENDERER_PROCESS_GONE_REASONS,
  TERMINAL_GPU_DOWNGRADE_REASONS,
  classifyGitWasmLoadFailure,
  daemonDegradedFallbackSchema,
  daemonLaunchFailedSchema,
  gitWasmUnavailableSchema,
  rendererProcessGoneSchema,
  rendererProcessGoneTelemetryReason,
  terminalGpuDowngradeSchema
} from './fork-reliability-telemetry'
import { eventSchemas } from './telemetry-events'

describe('fork reliability event schemas', () => {
  it('registers every event in the eventSchemas roster', () => {
    expect(eventSchemas.daemon_launch_failed).toBe(daemonLaunchFailedSchema)
    expect(eventSchemas.daemon_degraded_fallback).toBe(daemonDegradedFallbackSchema)
    expect(eventSchemas.terminal_gpu_downgrade).toBe(terminalGpuDowngradeSchema)
    expect(eventSchemas.renderer_process_gone).toBe(rendererProcessGoneSchema)
    expect(eventSchemas.git_wasm_unavailable).toBe(gitWasmUnavailableSchema)
  })

  it('accepts every declared enum value', () => {
    for (const errorClass of DAEMON_LAUNCH_FAILURE_CLASSES) {
      expect(daemonLaunchFailedSchema.safeParse({ error_class: errorClass }).success).toBe(true)
    }
    for (const reason of DAEMON_DEGRADED_FALLBACK_REASONS) {
      expect(daemonDegradedFallbackSchema.safeParse({ reason }).success).toBe(true)
    }
    for (const reason of TERMINAL_GPU_DOWNGRADE_REASONS) {
      expect(terminalGpuDowngradeSchema.safeParse({ from: 'gpu', to: 'cpu', reason }).success).toBe(
        true
      )
    }
    for (const reason of RENDERER_PROCESS_GONE_REASONS) {
      expect(rendererProcessGoneSchema.safeParse({ reason }).success).toBe(true)
    }
    for (const errorClass of GIT_WASM_UNAVAILABLE_CLASSES) {
      expect(gitWasmUnavailableSchema.safeParse({ error_class: errorClass }).success).toBe(true)
    }
  })

  it('rejects free-form strings so no payload can carry PII or terminal content', () => {
    expect(
      daemonLaunchFailedSchema.safeParse({ error_class: '/userhome/someone/orca-daemon: ENOENT' })
        .success
    ).toBe(false)
    expect(daemonDegradedFallbackSchema.safeParse({ reason: 'some raw error text' }).success).toBe(
      false
    )
    expect(rendererProcessGoneSchema.safeParse({ reason: 'segfault at 0x0' }).success).toBe(false)
  })

  it('rejects extra keys (.strict() discipline)', () => {
    expect(
      daemonLaunchFailedSchema.safeParse({ error_class: 'binary_missing', detail: 'x' }).success
    ).toBe(false)
    expect(
      terminalGpuDowngradeSchema.safeParse({
        from: 'worker',
        to: 'in_process',
        reason: 'worker_init_failed',
        adapter: 'ANGLE'
      }).success
    ).toBe(false)
  })

  it('accepts the two render-path downgrade transitions the strategy selector emits', () => {
    expect(
      terminalGpuDowngradeSchema.safeParse({
        from: 'worker',
        to: 'in_process',
        reason: 'worker_init_failed'
      }).success
    ).toBe(true)
    expect(
      terminalGpuDowngradeSchema.safeParse({
        from: 'gpu',
        to: 'cpu',
        reason: 'gpu_init_timeout'
      }).success
    ).toBe(true)
  })
})

describe('classifyGitWasmLoadFailure', () => {
  it('buckets a mis-served asset as a DELIVERY problem, not a bad Rust build', () => {
    // A dev-server 404 answers with HTML; wasm-bindgen only notices at compile time.
    expect(
      classifyGitWasmLoadFailure(
        new WebAssembly.CompileError('expected magic word 00 61 73 6d, found 3c 21 44 4f')
      )
    ).toBe('fetch_failed')
    expect(classifyGitWasmLoadFailure(new TypeError('Failed to fetch'))).toBe('fetch_failed')
  })

  it('separates a genuine compile failure from an instantiate failure', () => {
    expect(classifyGitWasmLoadFailure(new WebAssembly.CompileError('invalid opcode'))).toBe(
      'compile_failed'
    )
    expect(classifyGitWasmLoadFailure(new WebAssembly.LinkError('import not found'))).toBe(
      'instantiate_failed'
    )
    expect(classifyGitWasmLoadFailure(new WebAssembly.RuntimeError('unreachable'))).toBe(
      'instantiate_failed'
    )
  })

  it("reads Chromium's CSP rejection as an unsupported runtime, not a bad binary", () => {
    expect(
      classifyGitWasmLoadFailure(
        new WebAssembly.CompileError(
          "Refused to compile or instantiate WebAssembly module because 'wasm-unsafe-eval' is not an allowed source of script"
        )
      )
    ).toBe('unsupported_runtime')
  })

  it('buckets anything unrecognized rather than dropping the event at the strict validator', () => {
    const bucket = classifyGitWasmLoadFailure({ weird: true })
    expect(bucket).toBe('unknown')
    expect(gitWasmUnavailableSchema.safeParse({ error_class: bucket }).success).toBe(true)
  })

  it('emits only a closed-enum bucket, so no asset path can ride along', () => {
    const bucket = classifyGitWasmLoadFailure(
      new TypeError('Failed to fetch file:///home/someone/Orca.app/out/orca_git_wasm_bg.wasm')
    )
    expect(GIT_WASM_UNAVAILABLE_CLASSES).toContain(bucket)
    expect(bucket).not.toContain('/Users/')
  })
})

describe('rendererProcessGoneTelemetryReason', () => {
  it("maps each of Electron's hyphenated reasons onto the wire enum", () => {
    expect(rendererProcessGoneTelemetryReason('clean-exit')).toBe('clean_exit')
    expect(rendererProcessGoneTelemetryReason('abnormal-exit')).toBe('abnormal_exit')
    expect(rendererProcessGoneTelemetryReason('killed')).toBe('killed')
    expect(rendererProcessGoneTelemetryReason('crashed')).toBe('crashed')
    expect(rendererProcessGoneTelemetryReason('oom')).toBe('oom')
    expect(rendererProcessGoneTelemetryReason('launch-failed')).toBe('launch_failed')
    expect(rendererProcessGoneTelemetryReason('integrity-failure')).toBe('integrity_failure')
  })

  it('buckets unrecognized values to unknown instead of dropping at the strict validator', () => {
    expect(rendererProcessGoneTelemetryReason('some-future-reason')).toBe('unknown')
    expect(rendererProcessGoneTelemetryReason('')).toBe('unknown')
  })
})
