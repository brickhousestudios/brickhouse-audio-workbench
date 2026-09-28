export type AudioProcessPayload<TSession> = {
  job?: { job_id?: unknown; status?: unknown } | null;
  session?: TSession | null;
  artifacts?: unknown;
};

type AudioProcessHandlers<TSession> = {
  pollAudioJob(jobId: string): Promise<TSession>;
  hydrateSharedSession(session: TSession): TSession;
  refreshSharedSession(): Promise<TSession>;
  setRemoteArtifacts(artifacts: unknown[]): void;
  setSelectedArtifactId(artifactId: string): void;
};

const PENDING_JOB_STATUSES = new Set(["pending", "queued", "running"]);

export async function resolveAudioProcessResult<TSession>(
  processed: AudioProcessPayload<TSession>,
  handlers: AudioProcessHandlers<TSession>,
): Promise<TSession> {
  const jobId = String(processed.job?.job_id || "");
  const jobStatus = String(processed.job?.status || "");

  if (PENDING_JOB_STATUSES.has(jobStatus)) {
    if (!jobId) throw new Error("BrickHouse started processing without a job ID.");
    return handlers.pollAudioJob(jobId);
  }

  if (jobStatus === "succeeded") {
    if (processed.session) return handlers.hydrateSharedSession(processed.session);
    const outputs = Array.isArray(processed.artifacts) ? processed.artifacts : [];
    handlers.setRemoteArtifacts(outputs);
    handlers.setSelectedArtifactId("original");
    return handlers.refreshSharedSession();
  }

  if (jobStatus === "failed") {
    throw new Error("The selected BrickHouse tool failed. Please retry once.");
  }

  throw new Error("The selected BrickHouse tool did not start correctly.");
}
