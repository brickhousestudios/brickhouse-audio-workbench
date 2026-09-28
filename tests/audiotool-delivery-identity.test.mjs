import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const helperSource = readFileSync(new URL('../lib/audiotool-delivery-identity.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

function resolvedCurrentSourceArtifactId(session) {
  return session.selectedArtifactId === 'original' ? session.stagedSourceArtifactId : session.selectedArtifactId;
}

function lifecycleMatchesCurrent(session) {
  const life = session.deliveryLifecycle;
  if (!life || !session.source || !session.audiotoolDestination) return false;
  const resolved = resolvedCurrentSourceArtifactId(session);
  return life.sourceSha256 === session.source.sha256
    && life.selectedArtifactId === session.selectedArtifactId
    && life.sourceArtifactId === resolved
    && life.projectUuid === session.audiotoolDestination.projectUuid;
}

function isPreviousPlacement(session) {
  const life = session.deliveryLifecycle;
  if (!life) return false;
  const applyInFlight = life.status === 'APPLY_IN_FLIGHT';
  const outcomeUnknown = life.status === 'OUTCOME_UNKNOWN';
  const undoOutcomeUnknown = life.status === 'UNDO_OUTCOME_UNKNOWN';
  return !lifecycleMatchesCurrent(session) && !applyInFlight && !outcomeUnknown && !undoOutcomeUnknown;
}

function fixture(overrides = {}) {
  return {
    selectedArtifactId: 'original',
    stagedSourceArtifactId: 'staged-A',
    source: { sha256: 'abc' },
    audiotoolDestination: { projectUuid: 'proj-1' },
    deliveryLifecycle: {
      sourceSha256: 'abc',
      selectedArtifactId: 'original',
      sourceArtifactId: 'staged-A',
      projectUuid: 'proj-1',
      status: 'VERIFIED',
    },
    ...overrides,
  };
}

test('resolved current source artifact id matches A3 original vs selected', () => {
  assert.equal(resolvedCurrentSourceArtifactId({ selectedArtifactId: 'original', stagedSourceArtifactId: 'staged-A' }), 'staged-A');
  assert.equal(resolvedCurrentSourceArtifactId({ selectedArtifactId: 'original', stagedSourceArtifactId: 'staged-B' }), 'staged-B');
  assert.equal(resolvedCurrentSourceArtifactId({ selectedArtifactId: 'vocals-1', stagedSourceArtifactId: 'staged-A' }), 'vocals-1');
  assert.match(helperSource, /session\.selectedArtifactId === "original" \? session\.stagedSourceArtifactId : session\.selectedArtifactId/);
});

test('VERIFIED lifecycle with staged-A is current when staged-A is still resolved original', () => {
  const session = fixture();
  assert.equal(resolvedCurrentSourceArtifactId(session), 'staged-A');
  assert.equal(lifecycleMatchesCurrent(session), true);
  assert.equal(isPreviousPlacement(session), false);
});

test('adversarial same hash/original/project with staged-B is previous placement, not current VERIFIED', () => {
  const session = fixture({ stagedSourceArtifactId: 'staged-B' });
  session.deliveryLifecycle = {
    ...session.deliveryLifecycle,
    sourceArtifactId: 'staged-A',
  };
  assert.equal(session.source.sha256, 'abc');
  assert.equal(session.selectedArtifactId, 'original');
  assert.equal(session.audiotoolDestination.projectUuid, 'proj-1');
  assert.equal(session.deliveryLifecycle.sourceArtifactId, 'staged-A');
  assert.equal(session.stagedSourceArtifactId, 'staged-B');
  assert.equal(resolvedCurrentSourceArtifactId(session), 'staged-B');
  assert.equal(lifecycleMatchesCurrent(session), false);
  assert.equal(isPreviousPlacement(session), true);
  assert.match(page, /verifiedDelivery \? "SENT AND VERIFIED"/);
  assert.match(page, /previousPlacement && lifecycle\?\.receipt/);
  assert.match(page, /const verifiedDelivery = lifecycleIsCurrent && lifecycle\?\.status === "VERIFIED" && producerLoop\?\.nodes\.verify === "VERIFIED"/);
});

test('pending review identity requires resolved sourceArtifactId', () => {
  const pending = {
    status: 'NEEDS_USER',
    sourceSha256: 'abc',
    selectedArtifactId: 'original',
    sourceArtifactId: 'staged-A',
    projectUuid: 'proj-1',
    operationId: 'op-1',
  };
  const match = {
    ...fixture(),
    pendingDeliveryReview: pending,
  };
  const mismatch = {
    ...fixture({ stagedSourceArtifactId: 'staged-B' }),
    pendingDeliveryReview: pending,
  };
  const resolvedMatch = match.selectedArtifactId === 'original' ? match.stagedSourceArtifactId : match.selectedArtifactId;
  const resolvedMismatch = mismatch.selectedArtifactId === 'original' ? mismatch.stagedSourceArtifactId : mismatch.selectedArtifactId;
  assert.equal(pending.sourceArtifactId === resolvedMatch
    && pending.sourceSha256 === match.source.sha256
    && pending.selectedArtifactId === match.selectedArtifactId
    && pending.projectUuid === match.audiotoolDestination.projectUuid, true);
  assert.equal(pending.sourceArtifactId === resolvedMismatch, false);
  assert.match(page, /pendingReviewMatchesCurrent\(current\)/);
  assert.match(helperSource, /pending\.expectedConfirmRevision === session\.revision/);
});

test('page uses helper lifecycle match including sourceArtifactId', () => {
  assert.match(page, /from "\.\.\/lib\/audiotool-delivery-identity"/);
  assert.match(helperSource, /life\.sourceArtifactId === resolved/);
  assert.match(page, /lifecycleMatchesCurrent\(sharedSession\)/);
  assert.match(page, /isPreviousPlacement\(sharedSession\)/);
});
