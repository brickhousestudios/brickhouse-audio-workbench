import { NextResponse } from "next/server";
import { auth } from "./auth";
import { canonicalAuthUrl } from "./lib/auth-host";
import { authorizeProducerSession, type ProducerSession } from "./lib/producer-auth";

export const proxy = auth((request) => {
  const canonical = canonicalAuthUrl(request);
  if (!canonical) {
    return new NextResponse("Invalid authentication host", { status: 400 });
  }

  const authorization = authorizeProducerSession(request.auth as ProducerSession);
  if (authorization.ok === true) return NextResponse.next();

  if (authorization.status === 401) {
    const signIn = new URL("/api/auth/signin", canonical.origin);
    signIn.searchParams.set("callbackUrl", canonical.href);
    return NextResponse.redirect(signIn);
  }

  return new NextResponse(authorization.error, { status: authorization.status });
});

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.svg).*)"],
};
