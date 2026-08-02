// Test-only HTTPS identity for the local-certificate-trust E2E, minted in-process
// on every run. Why not a committed PEM: a published private key — even a
// throwaway one — is a published secret, and secret scanning rightly refuses it.
// Why not OpenSSL: Windows E2E runners have none, so the DER is assembled here
// (same approach as src/main/runtime/tls-certificate.ts), keeping the SANs for
// localhost and 127.0.0.1 that the committed fixture carried.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

function lengthBytes(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length])
  }
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content])
}

function sequence(...items: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(items))
}

function set(...items: Buffer[]): Buffer {
  return tagged(0x31, Buffer.concat(items))
}

function integer(value: Buffer): Buffer {
  const firstNonZero = value.findIndex((byte) => byte !== 0)
  const trimmed = firstNonZero === -1 ? Buffer.from([0]) : value.subarray(firstNonZero)
  return tagged(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function bitString(value: Buffer): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([0]), value]))
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split('.').map((part) => Number(part))
  const bytes = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f]
    let remaining = part >> 7
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80)
      remaining >>= 7
    }
    bytes.push(...encoded)
  }
  return tagged(0x06, Buffer.from(bytes))
}

// RFC 5280 requires UTCTime for validity dates before 2050.
function utcTime(date: Date): Buffer {
  const value = [
    `${date.getUTCFullYear()}`.slice(-2),
    `${date.getUTCMonth() + 1}`.padStart(2, '0'),
    `${date.getUTCDate()}`.padStart(2, '0'),
    `${date.getUTCHours()}`.padStart(2, '0'),
    `${date.getUTCMinutes()}`.padStart(2, '0'),
    `${date.getUTCSeconds()}`.padStart(2, '0'),
    'Z'
  ].join('')
  return tagged(0x17, Buffer.from(value, 'ascii'))
}

function commonName(name: string): Buffer {
  return sequence(
    set(sequence(objectIdentifier('2.5.4.3'), tagged(0x0c, Buffer.from(name, 'utf8'))))
  )
}

// GeneralNames: dNSName [2] localhost, iPAddress [7] 127.0.0.1 — Chromium rejects
// a certificate with no SAN before it ever reaches the trust decision under test.
function subjectAltNameExtension(): Buffer {
  const generalNames = sequence(
    tagged(0x82, Buffer.from('localhost', 'ascii')),
    tagged(0x87, Buffer.from([127, 0, 0, 1]))
  )
  return sequence(objectIdentifier('2.5.29.17'), tagged(0x04, generalNames))
}

// CA:TRUE, matching the fixture this replaced: the certificate is its own root.
function basicConstraintsExtension(): Buffer {
  return sequence(
    objectIdentifier('2.5.29.19'),
    tagged(0x01, Buffer.from([0xff])),
    tagged(0x04, sequence(tagged(0x01, Buffer.from([0xff]))))
  )
}

function toPem(label: string, der: Buffer): string {
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export type LocalHttpsTestIdentity = { key: string; cert: string }

export function createLocalHttpsTestIdentity(): LocalHttpsTestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyInfo = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  // sha256WithRSAEncryption, NULL parameters.
  const algorithm = sequence(
    objectIdentifier('1.2.840.113549.1.1.11'),
    tagged(0x05, Buffer.alloc(0))
  )
  const subject = commonName('localhost')
  const validity = sequence(
    utcTime(new Date(Date.now() - 60_000)),
    utcTime(new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000))
  )
  const tbsCertificate = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    algorithm,
    subject,
    validity,
    subject,
    publicKeyInfo,
    tagged(0xa3, sequence(basicConstraintsExtension(), subjectAltNameExtension()))
  )
  const signature = sign('sha256', tbsCertificate, privateKey)
  const cert = toPem('CERTIFICATE', sequence(tbsCertificate, algorithm, bitString(signature)))
  return { key, cert }
}

const identity = createLocalHttpsTestIdentity()

export const LOCAL_HTTPS_TEST_PRIVATE_KEY = identity.key
export const LOCAL_HTTPS_TEST_CERTIFICATE = identity.cert
