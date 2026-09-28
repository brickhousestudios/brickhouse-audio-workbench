type AuthAccount = { provider?: string; providerAccountId?: string } | null | undefined;
type AuthUser = { id?: string | null } | null | undefined;

export function applyAuthIdentityClaims<T extends Record<string, unknown>>(token: T, account: AuthAccount, user: AuthUser): T {
  const next: Record<string, unknown> = { ...token };

  if (account?.provider === "github") {
    delete next.submissionAccess;
    if (account.providerAccountId) next.githubSub = account.providerAccountId;
    else delete next.githubSub;
    return next as T;
  }

  if (account?.provider === "judge-access") {
    delete next.githubSub;
    if (user?.id === "brickhouse-submission-judge") next.submissionAccess = true;
    else delete next.submissionAccess;
    return next as T;
  }

  return next as T;
}
