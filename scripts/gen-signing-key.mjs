#!/usr/bin/env node
// Generate an ES256 (ECDSA P-256) key pair for UCP's *signed* tier
// (RFC 9421 HTTP Message Signatures). Prints ONLY the public JWK to paste
// into the Kauna agent profile; the private key is written to a git-ignored
// file and never printed.
//
//   node scripts/gen-signing-key.mjs            → keys/kauna-ucp-signing.private.pem
//
// Profile field: 2026-04-08 → "signing_keys": [ <jwk> ]
//                2026-08-25 → "keys": [ <jwk> ]   (JWK Set, RFC 7517)
// kid = RFC 7638 JWK thumbprint (recommended by UCP; required for Web Bot Auth interop).

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const out = process.argv[2] ?? 'keys/kauna-ucp-signing.private.pem'
if (existsSync(out)) {
  console.error(`${out} zaten var — üzerine yazılmadı.`)
  process.exit(1)
}
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
// RFC 7638: SHA-256 over the required members in lexicographic order.
const thumb = createHash('sha256')
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
  .digest('base64url')
mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true })
writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
console.log(JSON.stringify({ kid: thumb, kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: 'ES256', use: 'sig' }, null, 2))
console.error(`Özel anahtar: ${out} (git'e eklenmez; kimseyle paylaşma)`)
