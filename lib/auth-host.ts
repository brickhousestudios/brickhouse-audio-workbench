export type AuthHostEnv = {
  BRICKHOUSE_AUTH_ALLOWED_HOSTS?: string;
  BRICKHOUSE_AUTH_EXPECTED_PROTO?: string;
  VERCEL_URL?: string;
};

function configuredHosts(env: AuthHostEnv): Set<string> {
  const allowed = new Set(String(env.BRICKHOUSE_AUTH_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));

  const vercelUrl = String(env.VERCEL_URL || "").trim().toLowerCase();
  if (vercelUrl
    && vercelUrl.endsWith(".vercel.app")
    && !vercelUrl.includes(",")
    && !vercelUrl.includes("/")
    && !vercelUrl.includes(":")) {
    allowed.add(vercelUrl);
  }
  return allowed;
}

export function isAllowedAuthHost(headers: Headers, env: AuthHostEnv = process.env as AuthHostEnv): boolean {
  const allowed = configuredHosts(env);
  if (allowed.size === 0) return false;

  const host = (headers.get("host") ?? "").trim().toLowerCase();
  if (!host || host.includes(",") || !allowed.has(host)) return false;

  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost !== null) {
    const forwarded = forwardedHost.trim().toLowerCase();
    if (!forwarded || forwarded.includes(",") || forwarded !== host) return false;
  }

  const expectedProto = String(env.BRICKHOUSE_AUTH_EXPECTED_PROTO || "").trim().toLowerCase();
  const forwardedProto = headers.get("x-forwarded-proto");
  if (expectedProto && !["http", "https"].includes(expectedProto)) return false;
  if (forwardedProto !== null) {
    const forwarded = forwardedProto.trim().toLowerCase();
    if (!forwarded || forwarded.includes(",") || (expectedProto && forwarded !== expectedProto)) return false;
  }

  return true;
}

export function canonicalAuthUrl(request: Request, env: AuthHostEnv = process.env as AuthHostEnv): URL | null {
  if (!isAllowedAuthHost(request.headers, env)) return null;

  const host = (request.headers.get("host") ?? "").trim().toLowerCase();
  const expectedProto = String(env.BRICKHOUSE_AUTH_EXPECTED_PROTO || "").trim().toLowerCase();
  const forwardedProto = (request.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  const requestProto = new URL(request.url).protocol.replace(/:$/, "").toLowerCase();
  const protocol = expectedProto || forwardedProto || requestProto;
  if (!(["http", "https"] as const).includes(protocol as "http" | "https")) return null;

  const canonical = new URL(request.url);
  canonical.protocol = `${protocol}:`;
  canonical.host = host;
  return canonical;
}
