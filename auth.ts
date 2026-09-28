import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { applyAuthIdentityClaims } from "./lib/auth-identity";
import { isSubmissionAccessEnabled, verifySubmissionAccessCode } from "./lib/submission-access";

const expectedAuthProtocol = String(process.env.BRICKHOUSE_AUTH_EXPECTED_PROTO || "").trim().toLowerCase();
const useSecureCookies = expectedAuthProtocol === "http" ? false : true;
const submissionAccessEnabled = isSubmissionAccessEnabled();
const providers = submissionAccessEnabled
  ? [
      GitHub,
      Credentials({
        id: "judge-access",
        name: "Hackathon Judge Access",
        credentials: { accessCode: { label: "Access code", type: "password" } },
        authorize(credentials) {
          if (!verifySubmissionAccessCode(credentials?.accessCode)) return null;
          return { id: "brickhouse-submission-judge", name: "Let's Build Judge" };
        },
      }),
    ]
  : [GitHub];

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  useSecureCookies,
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, user }) {
      return applyAuthIdentityClaims(token, account, user);
    },
    async session({ session, token }) {
      if (session.user) {
        const mapped = session.user as typeof session.user & { githubSub?: string; submissionAccess?: boolean };
        mapped.githubSub = typeof token.githubSub === "string" ? token.githubSub : undefined;
        mapped.submissionAccess = token.submissionAccess === true;
      }
      return session;
    },
  },
});
