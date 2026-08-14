import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRpcUrl } from './fassets.js'

test('resolveRpcUrl prefers FLARE_RPC_URL when set', () => {
  const originalFlare = process.env.FLARE_RPC_URL
  const originalLegacy = process.env.COSTON2_RPC_URL

  process.env.FLARE_RPC_URL = 'https://flare.example'
  process.env.COSTON2_RPC_URL = 'https://legacy.example'

  try {
    assert.equal(resolveRpcUrl(), 'https://flare.example')
  } finally {
    process.env.FLARE_RPC_URL = originalFlare
    process.env.COSTON2_RPC_URL = originalLegacy
  }
})

test('resolveRpcUrl falls back to COSTON2_RPC_URL when FLARE is unset', () => {
  const originalFlare = process.env.FLARE_RPC_URL
  const originalLegacy = process.env.COSTON2_RPC_URL

  process.env.FLARE_RPC_URL = ''
  process.env.COSTON2_RPC_URL = 'https://legacy.example'

  try {
    assert.equal(resolveRpcUrl(), 'https://legacy.example')
  } finally {
    process.env.FLARE_RPC_URL = originalFlare
    process.env.COSTON2_RPC_URL = originalLegacy
  }
})

test('resolveRpcUrl trims env values and falls back through whitespace-only values', () => {
  const originalFlare = process.env.FLARE_RPC_URL
  const originalLegacy = process.env.COSTON2_RPC_URL

  process.env.FLARE_RPC_URL = '   https://flare.example  '
  process.env.COSTON2_RPC_URL = 'https://legacy.example'

  try {
    assert.equal(resolveRpcUrl(), 'https://flare.example')
  } finally {
    process.env.FLARE_RPC_URL = originalFlare
    process.env.COSTON2_RPC_URL = originalLegacy
  }
})

test('resolveRpcUrl resolves to undefined when no RPC env is configured', () => {
  const originalFlare = process.env.FLARE_RPC_URL
  const originalLegacy = process.env.COSTON2_RPC_URL

  delete process.env.FLARE_RPC_URL
  delete process.env.COSTON2_RPC_URL

  try {
    assert.equal(resolveRpcUrl(), undefined)
  } finally {
    process.env.FLARE_RPC_URL = originalFlare
    process.env.COSTON2_RPC_URL = originalLegacy
  }
})
