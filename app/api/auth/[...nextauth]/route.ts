import { NextRequest } from "next/server";
import { handlers } from "../../../../auth";
import { canonicalAuthUrl } from "../../../../lib/auth-host";

function canonicalRequest(request: NextRequest): NextRequest | Response {
  const url = canonicalAuthUrl(request);
  if (!url) return Response.json({ error: "Invalid authentication host" }, { status: 400 });

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new NextRequest(url, init);
}

export async function GET(request: NextRequest) {
  const canonical = canonicalRequest(request);
  return canonical instanceof Response ? canonical : handlers.GET(canonical);
}

export async function POST(request: NextRequest) {
  const canonical = canonicalRequest(request);
  return canonical instanceof Response ? canonical : handlers.POST(canonical);
}
