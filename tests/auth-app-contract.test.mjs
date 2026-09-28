import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('Auth.js v5 is pinned and app auth files exist', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies['next-auth'], '5.0.0-beta.32')
  for (const path of ['auth.ts', 'proxy.ts', 'app/api/auth/[...nextauth]/route.ts']) assert.equal(existsSync(new URL(path, root)), true, path)
})

test('Auth.js uses request-host inference, protocol-bound cookies, and stable GitHub provider account identity', () => {
  const source = read('auth.ts')
  assert.match(source, /trustHost:\s*true/)
  assert.match(source, /useSecureCookies/)
  assert.match(source, /BRICKHOUSE_AUTH_EXPECTED_PROTO/)
  assert.match(read('lib/auth-identity.ts'), /providerAccountId/)
  assert.match(source, /githubSub/)
  assert.doesNotMatch(source, /AUTH_URL|NEXTAUTH_URL/)
})

test('submission judge provider is server-gated and does not replace GitHub auth', () => {
  const source = read('auth.ts')
  assert.match(source, /GitHub/)
  assert.match(source, /Credentials/)
  assert.match(source, /isSubmissionAccessEnabled/)
  assert.match(source, /verifySubmissionAccessCode/)
  assert.match(source, /judge-access/)
  assert.match(source, /submissionAccess/)
  assert.doesNotMatch(source, /judge-code-123/)
})

test('proxy canonicalizes callback URLs from the validated request origin', () => {
  const source = read('proxy.ts')
  assert.match(source, /canonicalAuthUrl/)
  assert.match(source, /Invalid authentication host/)
  assert.ok(source.indexOf('canonicalAuthUrl') < source.indexOf('new URL("/api/auth/signin"'))
})

test('Auth.js route canonicalizes standalone NextRequest URL before handler execution', () => {
  const source = read('app/api/auth/[...nextauth]/route.ts')
  assert.match(source, /canonicalAuthUrl/)
  assert.match(source, /new NextRequest/)
  assert.match(source, /handlers\.GET\(canonical/)
  assert.match(source, /handlers\.POST\(canonical/)
})

test('audio route authenticates then replaces caller identity with server mapping', () => {
  const source = read('app/api/audio/[...path]/route.ts')
  assert.match(source, /await auth\(\)/)
  assert.match(source, /authorizeProducerSession/)
  assert.match(source, /applyProducerIdentity/)
  assert.doesNotMatch(source, /BRICKHOUSE_DEMO_USER_ID|BRICKHOUSE_DEMO_USER_EMAIL/)
})
