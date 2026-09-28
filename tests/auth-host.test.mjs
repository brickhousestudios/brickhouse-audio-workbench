import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalAuthUrl, isAllowedAuthHost } from '../lib/auth-host.ts'

const env = { BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3041,brickhouse-audio-workbench.vercel.app' }

test('auth host allowlist accepts only exact configured hosts', () => {
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041' }), env), true)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'evil.example' }), env), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041.evil.example' }), env), false)
})

test('forwarded host cannot override Host and must exactly match it when present', () => {
  assert.equal(isAllowedAuthHost(new Headers({ host: 'evil.example', 'x-forwarded-host': 'brickhouse-audio-workbench.vercel.app' }), env), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'brickhouse-audio-workbench.vercel.app', 'x-forwarded-host': 'evil.example' }), env), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'brickhouse-audio-workbench.vercel.app', 'x-forwarded-host': 'brickhouse-audio-workbench.vercel.app' }), env), true)
})

test('comma-chained forwarded hosts are rejected', () => {
  const headers = new Headers({ host: 'brickhouse-audio-workbench.vercel.app', 'x-forwarded-host': 'brickhouse-audio-workbench.vercel.app, evil.example' })
  assert.equal(isAllowedAuthHost(headers, env), false)
})

test('Vercel Preview trusts only the exact system-provided deployment host', () => {
  const previewEnv = {
    VERCEL_URL: 'brickhouse-audio-workbench-abc123-team.vercel.app',
    BRICKHOUSE_AUTH_EXPECTED_PROTO: 'https',
  }
  assert.equal(isAllowedAuthHost(new Headers({
    host: 'brickhouse-audio-workbench-abc123-team.vercel.app',
    'x-forwarded-host': 'brickhouse-audio-workbench-abc123-team.vercel.app',
    'x-forwarded-proto': 'https',
  }), previewEnv), true)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'evil.brickhouse-audio-workbench-abc123-team.vercel.app' }), previewEnv), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'brickhouse-audio-workbench-abc123-team.vercel.app.evil.example' }), previewEnv), false)
})

test('malformed VERCEL_URL cannot create an auth host exception', () => {
  assert.equal(isAllowedAuthHost(new Headers({ host: 'brickhouse-audio-workbench.vercel.app' }), {
    VERCEL_URL: 'https://brickhouse-audio-workbench.vercel.app/path',
  }), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'brickhouse-audio-workbench.vercel.app' }), {
    VERCEL_URL: 'brickhouse-audio-workbench.vercel.app,evil.example',
  }), false)
})

test('configured local auth hosts accept both exact loopback names and reject conflicting forwarded protocol', () => {
  const localEnv = { BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3041,localhost:3041', BRICKHOUSE_AUTH_EXPECTED_PROTO: 'http' }
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041', 'x-forwarded-proto': 'http' }), localEnv), true)
  assert.equal(isAllowedAuthHost(new Headers({ host: 'localhost:3041', 'x-forwarded-proto': 'http' }), localEnv), true)
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041', 'x-forwarded-proto': 'https' }), localEnv), false)
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041', 'x-forwarded-proto': 'http,https' }), localEnv), false)
})

test('canonical auth URL replaces standalone localhost with validated M4 host and protocol', () => {
  const request = new Request('http://localhost:3041/api/auth/providers?x=1', { headers: { host: '127.0.0.1:3041' } })
  const url = canonicalAuthUrl(request, { BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3041', BRICKHOUSE_AUTH_EXPECTED_PROTO: 'http' })
  assert.equal(url?.href, 'http://127.0.0.1:3041/api/auth/providers?x=1')
})

test('auth host guard fails closed when no host allowlist is configured', () => {
  assert.equal(isAllowedAuthHost(new Headers({ host: '127.0.0.1:3041' }), {}), false)
  assert.equal(canonicalAuthUrl(new Request('http://localhost:3041/', { headers: { host: '127.0.0.1:3041' } }), {}), null)
})
