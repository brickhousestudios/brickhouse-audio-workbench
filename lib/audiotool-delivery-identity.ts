export type DeliveryIdentitySession = {
  revision: number;
  selectedArtifactId: string;
  stagedSourceArtifactId?: string | null;
  source?: { sha256: string } | null;
  audiotoolDestination?: { projectUuid: string } | null;
  pendingDeliveryReview?: {
    status: string;
    sourceSha256: string;
    selectedArtifactId: string;
    sourceArtifactId: string;
    projectUuid: string;
    expectedConfirmRevision: number;
  } | null;
  deliveryLifecycle?: {
    sourceSha256: string;
    selectedArtifactId: string;
    sourceArtifactId: string;
    projectUuid: string;
    status: string;
  } | null;
};

export function resolvedCurrentSourceArtifactId(session: Pick<DeliveryIdentitySession, "selectedArtifactId" | "stagedSourceArtifactId">): string | null | undefined {
  return session.selectedArtifactId === "original" ? session.stagedSourceArtifactId : session.selectedArtifactId;
}

export function lifecycleMatchesCurrent(session: DeliveryIdentitySession): boolean {
  const life = session.deliveryLifecycle;
  if (!life || !session.source || !session.audiotoolDestination) return false;
  const resolved = resolvedCurrentSourceArtifactId(session);
  return life.sourceSha256 === session.source.sha256
    && life.selectedArtifactId === session.selectedArtifactId
    && life.sourceArtifactId === resolved
    && life.projectUuid === session.audiotoolDestination.projectUuid;
}

export function pendingReviewMatchesCurrent(session: DeliveryIdentitySession): boolean {
  const pending = session.pendingDeliveryReview;
  if (!pending || pending.status !== "NEEDS_USER" || !session.source || !session.audiotoolDestination) return false;
  const resolved = resolvedCurrentSourceArtifactId(session);
  return pending.sourceSha256 === session.source.sha256
    && pending.selectedArtifactId === session.selectedArtifactId
    && pending.sourceArtifactId === resolved
    && pending.projectUuid === session.audiotoolDestination.projectUuid
    && pending.expectedConfirmRevision === session.revision;
}

export function isPreviousPlacement(session: DeliveryIdentitySession): boolean {
  const life = session.deliveryLifecycle;
  if (!life) return false;
  const applyInFlight = life.status === "APPLY_IN_FLIGHT";
  const outcomeUnknown = life.status === "OUTCOME_UNKNOWN";
  const undoOutcomeUnknown = life.status === "UNDO_OUTCOME_UNKNOWN";
  return !lifecycleMatchesCurrent(session) && !applyInFlight && !outcomeUnknown && !undoOutcomeUnknown;
}
