import { readFileSync } from 'node:fs'
import type {
  BaseAgent,
  IdentityCallback,
  ParsedKey,
  PublicKeyEntry,
  SignCallback,
  SigningRequestOptions
} from 'ssh2'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import { loadSsh2 } from './ssh2-module'

type AgentPublicKey = ParsedKey | Buffer | string | PublicKeyEntry

function comparablePublicKey(key: AgentPublicKey): ParsedKey | Buffer | string {
  if (typeof key === 'object' && 'pubKey' in key) {
    const pubKey = key.pubKey
    if (typeof pubKey === 'object' && 'pubKey' in pubKey) {
      return pubKey.pubKey
    }
    return pubKey
  }
  return key
}

type IdentityFilteredAgentCtor = new (
  socketPath: string,
  agent: BaseAgent,
  allowedKeys: ParsedKey[]
) => BaseAgent<ParsedKey | Buffer | string>

let lazyCtor: IdentityFilteredAgentCtor | null = null

// Why: the class extends ssh2's BaseAgent VALUE, which as a top-level class
// would force the ~25ms ssh2 require at module load on the startup path (the
// reason ssh2 moved behind loadSsh2()). Define it on first agent construction.
function identityFilteredAgentCtor(): IdentityFilteredAgentCtor {
  if (lazyCtor) {
    return lazyCtor
  }
  const ssh2 = loadSsh2()
  class IdentityFilteredAgent extends ssh2.BaseAgent<ParsedKey | Buffer | string> {
    readonly kind = 'identity-filtered-agent'
    declare getStream?: BaseAgent['getStream']

    constructor(
      readonly socketPath: string,
      private readonly agent: BaseAgent,
      private readonly allowedKeys: ParsedKey[]
    ) {
      super()
      if (agent.getStream) {
        this.getStream = agent.getStream.bind(agent)
      }
    }

    getIdentities(callback: IdentityCallback): void {
      this.agent.getIdentities((error, keys) => {
        if (error) {
          callback(error)
          return
        }
        callback(
          undefined,
          keys?.filter((key) =>
            this.allowedKeys.some((allowedKey) => allowedKey.equals(comparablePublicKey(key)))
          ) ?? []
        )
      })
    }

    sign(
      pubKey: ParsedKey | Buffer | string,
      data: Buffer,
      optionsOrCallback?: SigningRequestOptions | SignCallback,
      callback?: SignCallback
    ): void {
      if (typeof optionsOrCallback === 'function') {
        this.agent.sign(pubKey, data, optionsOrCallback)
        return
      }
      this.agent.sign(pubKey, data, optionsOrCallback ?? {}, callback)
    }
  }
  lazyCtor = IdentityFilteredAgent
  return lazyCtor
}

function parseIdentityKeyFile(filePath: string): ParsedKey | undefined {
  try {
    const parsed = loadSsh2().utils.parseKey(readFileSync(filePath)) as
      | ParsedKey
      | ParsedKey[]
      | Error
    if (parsed instanceof Error) {
      return undefined
    }
    return Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    return undefined
  }
}

function readIdentityKeys(paths: string[]): ParsedKey[] {
  const keys: ParsedKey[] = []
  for (const path of paths) {
    const identityPath = resolveSshConfigHomePath(path)
    const key = parseIdentityKeyFile(`${identityPath}.pub`) ?? parseIdentityKeyFile(identityPath)
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

export function createIdentityFilteredAgent(
  agentSocket: string,
  identityFilePaths: string[]
): BaseAgent | undefined {
  const identityKeys = readIdentityKeys(identityFilePaths)
  if (identityKeys.length === 0) {
    return undefined
  }
  // Why: IdentitiesOnly must not offer every key loaded in the agent. ssh2 has
  // no built-in equivalent, so wrap the agent and expose only IdentityFile keys.
  const Ctor = identityFilteredAgentCtor()
  return new Ctor(agentSocket, loadSsh2().createAgent(agentSocket), identityKeys)
}
