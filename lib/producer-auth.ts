import { isSubmissionAccessEnabled } from "./submission-access.ts";

export type ProducerSession = {
  user?: { githubSub?: unknown; submissionAccess?: unknown } | null;
} | null | undefined;

export type ProducerAuthEnv = {
  BRICKHOUSE_AUTH_GITHUB_SUB?: string;
  BRICKHOUSE_PRODUCER_USER_ID?: string;
  BRICKHOUSE_PRODUCER_USER_EMAIL?: string;
  BRICKHOUSE_SELF_HOST?: string;
  BRICKHOUSE_AUTH_ALLOWED_HOSTS?: string;
  BRICKHOUSE_AUTH_EXPECTED_PROTO?: string;
  BRICKHOUSE_SUBMISSION_ACCESS_ENABLED?: string;
  BRICKHOUSE_SUBMISSION_ACCESS_CODE?: string;
  BRICKHOUSE_SUBMISSION_USER_ID?: string;
  BRICKHOUSE_SUBMISSION_USER_EMAIL?: string;
};

export type ProducerAuthorization =
  | { ok: true; userId: string; userEmail: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";

function isLoopbackHost(host: string): boolean {
  const match = host.match(/^(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isLoopbackSelfHost(env: ProducerAuthEnv): boolean {
  if (clean(env.BRICKHOUSE_SELF_HOST) !== "1") return false;
  if (clean(env.BRICKHOUSE_AUTH_EXPECTED_PROTO).toLowerCase() !== "http") return false;
  const hosts = clean(env.BRICKHOUSE_AUTH_ALLOWED_HOSTS)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length > 0 && hosts.every(isLoopbackHost);
}

export function authorizeProducerSession(session: ProducerSession, env: ProducerAuthEnv = process.env as ProducerAuthEnv): ProducerAuthorization {
  const producerUserId = clean(env.BRICKHOUSE_PRODUCER_USER_ID);
  const producerUserEmail = clean(env.BRICKHOUSE_PRODUCER_USER_EMAIL);
  if (!producerUserId || !producerUserEmail) {
    return { ok: false, status: 503, error: "Producer authentication unavailable" };
  }

  if (isLoopbackSelfHost(env)) {
    return { ok: true, userId: producerUserId, userEmail: producerUserEmail };
  }

  if (isSubmissionAccessEnabled(env) && session?.user?.submissionAccess === true) {
    const submissionUserId = clean(env.BRICKHOUSE_SUBMISSION_USER_ID);
    const submissionUserEmail = clean(env.BRICKHOUSE_SUBMISSION_USER_EMAIL);
    if (!submissionUserId || !submissionUserEmail) {
      return { ok: false, status: 503, error: "Submission access unavailable" };
    }
    return { ok: true, userId: submissionUserId, userEmail: submissionUserEmail };
  }

  if (!session) return { ok: false, status: 401, error: "Authentication required" };

  const allowedGithubSub = clean(env.BRICKHOUSE_AUTH_GITHUB_SUB);
  if (!allowedGithubSub) {
    return { ok: false, status: 503, error: "Producer authentication unavailable" };
  }

  const githubSub = clean(session.user?.githubSub);
  if (!githubSub || githubSub !== allowedGithubSub) {
    return { ok: false, status: 403, error: "Producer authorization required" };
  }

  return { ok: true, userId: producerUserId, userEmail: producerUserEmail };
}

export function applyProducerIdentity(headers: HeadersInit, authorization: Extract<ProducerAuthorization, { ok: true }>): Headers {
  const mapped = new Headers(headers);
  mapped.delete("oai-authenticated-user-id");
  mapped.delete("oai-authenticated-user-email");
  mapped.set("oai-authenticated-user-id", authorization.userId);
  mapped.set("oai-authenticated-user-email", authorization.userEmail);
  return mapped;
}
