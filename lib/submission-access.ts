import { timingSafeEqual } from "node:crypto";

export type SubmissionAccessEnv = {
  BRICKHOUSE_SUBMISSION_ACCESS_ENABLED?: string;
  BRICKHOUSE_SUBMISSION_ACCESS_CODE?: string;
  BRICKHOUSE_SUBMISSION_USER_ID?: string;
  BRICKHOUSE_SUBMISSION_USER_EMAIL?: string;
};

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function isSubmissionAccessEnabled(env: SubmissionAccessEnv = process.env as SubmissionAccessEnv): boolean {
  return clean(env.BRICKHOUSE_SUBMISSION_ACCESS_ENABLED) === "1"
    && clean(env.BRICKHOUSE_SUBMISSION_ACCESS_CODE).length > 0
    && clean(env.BRICKHOUSE_SUBMISSION_USER_ID).length > 0
    && clean(env.BRICKHOUSE_SUBMISSION_USER_EMAIL).length > 0;
}

export function verifySubmissionAccessCode(value: unknown, env: SubmissionAccessEnv = process.env as SubmissionAccessEnv): boolean {
  if (!isSubmissionAccessEnabled(env) || typeof value !== "string") return false;
  const expected = Buffer.from(env.BRICKHOUSE_SUBMISSION_ACCESS_CODE ?? "", "utf8");
  const actual = Buffer.from(value, "utf8");
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}
