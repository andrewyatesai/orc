import { X509Certificate, createPrivateKey } from 'node:crypto'
import { createServer } from 'node:https'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY,
  createLocalHttpsTestIdentity
} from './local-https-test-certificate'

describe('local https test certificate', () => {
  it('is minted at runtime, never committed', () => {
    // Why: this file replaced a committed PEM; guard against one being pasted back.
    // Matches a real PEM block (header then base64), not the header literals used to build one.
    const source = readFileSync(join(__dirname, 'local-https-test-certificate.ts'), 'utf8')
    expect(source).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{40}/)
    expect(source).not.toMatch(/BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/]{40}/)
  })

  it('is a fresh identity on each generation', () => {
    expect(createLocalHttpsTestIdentity().key).not.toEqual(createLocalHttpsTestIdentity().key)
  })

  it('names localhost and 127.0.0.1 so hostname verification passes', () => {
    const cert = new X509Certificate(LOCAL_HTTPS_TEST_CERTIFICATE)
    expect(cert.subject).toContain('CN=localhost')
    expect(cert.checkHost('localhost')).toBe('localhost')
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1')
  })

  it('is currently valid and self-signed', () => {
    const cert = new X509Certificate(LOCAL_HTTPS_TEST_CERTIFICATE)
    const now = Date.now()
    expect(Date.parse(cert.validFrom)).toBeLessThanOrEqual(now)
    expect(Date.parse(cert.validTo)).toBeGreaterThan(now)
    expect(cert.issuer).toEqual(cert.subject)
    expect(cert.verify(cert.publicKey)).toBe(true)
  })

  it('pairs the certificate with its private key', () => {
    const cert = new X509Certificate(LOCAL_HTTPS_TEST_CERTIFICATE)
    expect(cert.checkPrivateKey(createPrivateKey(LOCAL_HTTPS_TEST_PRIVATE_KEY))).toBe(true)
  })

  it('serves TLS that a strict client accepts', async () => {
    const server = createServer(
      { cert: LOCAL_HTTPS_TEST_CERTIFICATE, key: LOCAL_HTTPS_TEST_PRIVATE_KEY },
      (_req, res) => {
        res.writeHead(200)
        res.end('ok')
      }
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            // Why: verify against the cert itself — rejectUnauthorized would pass on any cert if disabled.
            ca: LOCAL_HTTPS_TEST_CERTIFICATE,
            servername: 'localhost',
            rejectUnauthorized: true
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => resolve(data))
          }
        )
        req.on('error', reject)
        req.end()
      })
      expect(body).toBe('ok')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
