import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  AUDIO_TRANSPORT_CONTRACT_ID,
  AUDIO_TRANSPORT_LIMITS,
  hasAudioTransportRoute,
  matchAudioTransportRoute,
} from '../lib/audio-transport-contract.ts'

const snapshotUrl = new URL('../config/audio-transport-contract.json', import.meta.url)
const snapshotBytes = readFileSync(snapshotUrl)
const snapshot = JSON.parse(snapshotBytes)
const expectedHash = readFileSync(new URL('../config/audio-transport-contract.sha256', import.meta.url), 'utf8').trim()

test('Workbench transport snapshot retains the exact synchronized contract fingerprint', () => {
  assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), expectedHash)
  assert.equal(AUDIO_TRANSPORT_CONTRACT_ID, 'audio-workbench-rev5-producer-loop')
  assert.equal(snapshot.routes.length, 30)
})

test('every synchronized route example is accepted by the Workbench transport matcher', () => {
  for (const route of snapshot.routes) {
    assert.equal(matchAudioTransportRoute(route.method, route.examplePath)?.id, route.id, route.id)
    assert.equal(hasAudioTransportRoute(route.id), true, route.id)
  }
})

test('unsupported secondary routes are absent rather than silently proxied', () => {
  for (const routeId of ['audiotool.regions', 'audiotool.analyze', 'conversation.ask']) {
    assert.equal(hasAudioTransportRoute(routeId), false, routeId)
  }
  assert.equal(matchAudioTransportRoute('GET', '/v1/audio/audiotool/regions'), null)
  assert.equal(matchAudioTransportRoute('POST', '/v1/audio/audiotool/analyze'), null)
  assert.equal(matchAudioTransportRoute('POST', '/v1/audio/conversation/ask'), null)
})

test('Workbench preview limits come from the synchronized transport contract', () => {
  assert.equal(AUDIO_TRANSPORT_LIMITS.candidatePreviewBytes, 256 * 1024)
  assert.equal(AUDIO_TRANSPORT_LIMITS.artifactPreviewBytes, 768 * 1024)
  assert.equal(AUDIO_TRANSPORT_LIMITS.uploadChunkBytes, 768 * 1024)
  assert.equal(AUDIO_TRANSPORT_LIMITS.responseBytes, 2 * 1024 * 1024)
})

test('unsupported secondary UI is capability-gated instead of sending doomed requests', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /VOCAL_ANALYSIS_AVAILABLE = hasAudioTransportRoute\("audiotool\.regions"\)/)
  assert.match(page, /ASK_ABOUT_AUDIO_AVAILABLE = hasAudioTransportRoute\("conversation\.ask"\)/)
  assert.match(page, /disabled=\{!VOCAL_ANALYSIS_AVAILABLE/)
  assert.match(page, /disabled=\{!ASK_ABOUT_AUDIO_AVAILABLE/)
})
