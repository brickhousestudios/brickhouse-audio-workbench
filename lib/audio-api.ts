import { AUDIO_TRANSPORT_LIMITS, isAllowedAudioTransportRoute } from "./audio-transport-contract.ts";

export type AudioApiEnv = {
  /** Private Sites HTTP binding for the existing BrickHouse Workbench Harpoon target. */
  CUSTOMER_HTTP_WORKBENCH?: string;
  BRICKHOUSE_AUDIO_CONTROL_URL?: string;
  /** Public HTTPS Vercel relay. When configured, it takes precedence over direct gateway mode. */
  BRICKHOUSE_AUDIO_RELAY_URL?: string;
  BRICKHOUSE_AUDIO_RELAY_TOKEN?: string;
  BRICKHOUSE_AUDIO_CONTROL_TOKEN?: string;
};

type FetchLike = (request: Request) => Promise<Response>;

const PRIVATE_FIELD_PATTERN = /(token|secret|authorization|credential|password|cookie|uri|path)/i;
const RELAY_CHUNK_BYTES = AUDIO_TRANSPORT_LIMITS.uploadChunkBytes;
const LIBRARY_PREVIEW_CHUNK_BYTES = AUDIO_TRANSPORT_LIMITS.candidatePreviewBytes;
const RELAY_MAX_PARTS = AUDIO_TRANSPORT_LIMITS.maxUploadParts;

export async function handleAudioApi(
  request: Request,
  env: AudioApiEnv,
  fetchImpl: FetchLike = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  const previewMatch = request.method === "GET" ? url.pathname.match(/^\/api\/audio\/artifacts\/([^/]+)\/preview$/) : null;
  const candidatePreviewMatch = request.method === "GET" ? url.pathname.match(/^\/api\/audio\/library\/candidates\/([0-9]{5,8})\/preview$/) : null;
  const route = previewMatch || candidatePreviewMatch ? null : resolveRoute(url.pathname, request.method);
  if (route && !isAllowedAudioTransportRoute(request.method, route.upstreamPath)) return null;
  if (!previewMatch && !candidatePreviewMatch && !route) return null;
  if (route && /^\/v1\/audio\/candidates\/[0-9]{1,3}$/.test(route.upstreamPath)) {
    // Native Audiotool search parameters (read-only). Only allow-listed keys are forwarded.
    const forwarded = new URLSearchParams();
    for (const key of ["provider", "q", "kind", "bpmMin", "bpmMax", "tag"]) {
      const value = url.searchParams.get(key);
      if (value) forwarded.set(key, value.slice(0, 200));
    }
    if ([...forwarded.keys()].length) route.upstreamPath = `${route.upstreamPath}?${forwarded}`;
  }

  const userId = request.headers.get("oai-authenticated-user-id");
  const userEmail = request.headers.get("oai-authenticated-user-email");
  if (!userId || !userEmail) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  if (route?.mutating) {
    const originError = validateMutationOrigin(request);
    if (originError) return originError;
    if (!request.headers.get("x-brickhouse-operation-id")) {
      return Response.json({ error: "Operation ID required" }, { status: 400 });
    }
  }

  const controlToken = env.BRICKHOUSE_AUDIO_CONTROL_TOKEN?.trim();
  const relayToken = env.BRICKHOUSE_AUDIO_RELAY_TOKEN?.trim() || controlToken;
  const relayUrl = normalizedGatewayUrl(env.BRICKHOUSE_AUDIO_RELAY_URL);
  if (previewMatch) {
    if (relayUrl ? !relayToken : !controlToken) return Response.json({ error: "Remote audio service unavailable" }, { status: 503 });
    const artifactId = decodeURIComponent(previewMatch[1]);
    if (relayUrl) return handlePreviewRequest(request, artifactId, { relayUrl, token: relayToken!, userId, userEmail, fetchImpl });
    const gatewayUrl = normalizedGatewayUrl(env.CUSTOMER_HTTP_WORKBENCH) ?? normalizedGatewayUrl(env.BRICKHOUSE_AUDIO_CONTROL_URL);
    if (!gatewayUrl) return Response.json({ error: "Remote audio service unavailable" }, { status: 503 });
    return handlePreviewRequest(request, artifactId, { gatewayUrl, token: controlToken!, userId, userEmail, fetchImpl });
  }
  if (candidatePreviewMatch) {
    if (relayUrl ? !relayToken : !controlToken) return Response.json({ error: "Producer Library preview unavailable" }, { status: 503 });
    const providerId = candidatePreviewMatch[1];
    if (relayUrl) return handleLibraryPreviewRequest(request, providerId, { relayUrl, token: relayToken!, userId, userEmail, fetchImpl });
    const gatewayUrl = normalizedGatewayUrl(env.CUSTOMER_HTTP_WORKBENCH) ?? normalizedGatewayUrl(env.BRICKHOUSE_AUDIO_CONTROL_URL);
    if (!gatewayUrl) return Response.json({ error: "Producer Library preview unavailable" }, { status: 503 });
    return handleLibraryPreviewRequest(request, providerId, { gatewayUrl, token: controlToken!, userId, userEmail, fetchImpl });
  }
  if (relayUrl && relayToken) {
    return handleRelayRequest(request, route!, relayUrl, relayToken, userId, userEmail, fetchImpl);
  }

  const gatewayUrl = normalizedGatewayUrl(env.CUSTOMER_HTTP_WORKBENCH)
    ?? normalizedGatewayUrl(env.BRICKHOUSE_AUDIO_CONTROL_URL);
  if (!gatewayUrl || !controlToken) {
    return Response.json({ error: "Remote audio service unavailable" }, { status: 503 });
  }

  let upstreamRequest: Request;
  try {
    upstreamRequest = await createUpstreamRequest(
      request,
      `${gatewayUrl}${route!.upstreamPath}`,
      controlToken,
      userId,
      userEmail,
    );
  } catch {
    return Response.json({ error: "Invalid audio staging request" }, { status: 400 });
  }

  return fetchAndSanitize(upstreamRequest, fetchImpl);
}


type PreviewRequestOptions = {
  relayUrl?: string;
  gatewayUrl?: string;
  token: string;
  userId: string;
  userEmail: string;
  fetchImpl: FetchLike;
};

function previewRange(request: Request, chunkBytes = RELAY_CHUNK_BYTES) {
  const header = request.headers.get("range");
  if (!header) return { offset: 0, maxBytes: chunkBytes };
  const match = header.match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return null;
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : offset + chunkBytes - 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return null;
  return { offset, maxBytes: Math.min(chunkBytes, requestedEnd - offset + 1) };
}

async function handlePreviewRequest(request: Request, artifactId: string, options: PreviewRequestOptions): Promise<Response> {
  if (!artifactId || artifactId.includes("/")) return Response.json({ error: "Invalid audio preview artifact" }, { status: 400 });
  const range = previewRange(request);
  if (!range) return new Response(null, { status: 416, headers: { "accept-ranges": "bytes" } });
  const upstreamPath = `/v1/audio/artifacts/${encodeURIComponent(artifactId)}/preview/${range.offset}/${range.maxBytes}`;
  if (!isAllowedAudioTransportRoute("GET", upstreamPath)) return Response.json({ error: "Remote audio preview unavailable" }, { status: 503 });
  let upstream: Response;
  try {
    if (options.relayUrl) {
      const relayRequest = new Request(`${options.relayUrl}/api/request`, {
        method: "POST",
        headers: relayHeaders(options.token, "application/json"),
        body: JSON.stringify({ method: "GET", path: upstreamPath, userId: options.userId, userEmail: options.userEmail, contentType: "application/json", bodyText: "" }),
      });
      upstream = await options.fetchImpl(relayRequest);
    } else {
      const headers = new Headers({
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        "x-brickhouse-control-token": options.token,
        "x-brickhouse-user-id": options.userId,
        "x-brickhouse-user-email": options.userEmail,
      });
      upstream = await options.fetchImpl(new Request(`${options.gatewayUrl}${upstreamPath}`, { headers }));
    }
  } catch {
    return Response.json({ error: "Remote audio preview unavailable" }, { status: 503 });
  }
  if (!upstream.ok) return Response.json({ error: "Remote audio preview unavailable" }, { status: upstream.status === 404 ? 404 : 502 });
  try {
    const payload = await upstream.json() as Record<string, unknown>;
    const payloadArtifactId = String(payload.artifactId || "");
    const mimeType = String(payload.mimeType || "audio/wav");
    const offset = Number(payload.offset);
    const chunkBytes = Number(payload.chunkBytes);
    const totalBytes = Number(payload.totalBytes);
    const chunkBase64 = String(payload.chunkBase64 || "");
    if (payloadArtifactId !== artifactId || !mimeType.startsWith("audio/") || offset !== range.offset || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > range.maxBytes || !Number.isSafeInteger(totalBytes) || totalBytes < offset + chunkBytes || !chunkBase64) {
      return Response.json({ error: "Invalid audio preview response" }, { status: 502 });
    }
    const bytes = Buffer.from(chunkBase64, "base64");
    if (bytes.byteLength !== chunkBytes) return Response.json({ error: "Invalid audio preview response" }, { status: 502 });
    const end = offset + chunkBytes - 1;
    return new Response(bytes, {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": String(chunkBytes),
        "content-range": `bytes ${offset}-${end}/${totalBytes}`,
        "content-type": mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Invalid audio preview response" }, { status: 502 });
  }
}

async function handleLibraryPreviewRequest(request: Request, providerId: string, options: PreviewRequestOptions): Promise<Response> {
  if (!/^[0-9]{5,8}$/.test(providerId)) return Response.json({ error: "Invalid Producer Library candidate" }, { status: 400 });
  const range = previewRange(request, LIBRARY_PREVIEW_CHUNK_BYTES);
  if (!range) return new Response(null, { status: 416, headers: { "accept-ranges": "bytes" } });
  const upstreamPath = `/v1/audio/library/candidates/${providerId}/preview/${range.offset}/${range.maxBytes}`;
  if (!isAllowedAudioTransportRoute("GET", upstreamPath)) return Response.json({ error: "Producer Library preview unavailable" }, { status: 503 });
  let upstream: Response;
  try {
    if (options.relayUrl) {
      upstream = await options.fetchImpl(new Request(`${options.relayUrl}/api/request`, {
        method: "POST",
        headers: relayHeaders(options.token, "application/json"),
        body: JSON.stringify({ method: "GET", path: upstreamPath, userId: options.userId, userEmail: options.userEmail, contentType: "application/json", bodyText: "" }),
      }));
    } else {
      const headers = new Headers({
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        "x-brickhouse-control-token": options.token,
        "x-brickhouse-user-id": options.userId,
        "x-brickhouse-user-email": options.userEmail,
      });
      upstream = await options.fetchImpl(new Request(`${options.gatewayUrl}${upstreamPath}`, { headers }));
    }
  } catch {
    return Response.json({ error: "Producer Library preview unavailable" }, { status: 503 });
  }
  if (!upstream.ok) return Response.json({ error: "Producer Library preview unavailable" }, { status: upstream.status === 404 ? 404 : 502 });
  try {
    const payload = await upstream.json() as Record<string, unknown>;
    const candidate = payload.candidate as Record<string, unknown> | undefined;
    const candidateId = String(candidate?.candidateId || "");
    const mimeType = String(payload.mimeType || "audio/mpeg");
    const offset = Number(payload.offset);
    const chunkBytes = Number(payload.chunkBytes);
    const totalBytes = Number(payload.totalBytes);
    const chunkBase64 = String(payload.chunkBase64 || "");
    if (candidateId !== `looperman:${providerId}` || !mimeType.startsWith("audio/") || offset !== range.offset || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > range.maxBytes || !Number.isSafeInteger(totalBytes) || totalBytes < offset + chunkBytes || !chunkBase64) {
      return Response.json({ error: "Invalid Producer Library preview response" }, { status: 502 });
    }
    const bytes = Buffer.from(chunkBase64, "base64");
    if (bytes.byteLength !== chunkBytes) return Response.json({ error: "Invalid Producer Library preview response" }, { status: 502 });
    const end = offset + chunkBytes - 1;
    return new Response(bytes, {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": String(chunkBytes),
        "content-range": `bytes ${offset}-${end}/${totalBytes}`,
        "content-type": mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Invalid Producer Library preview response" }, { status: 502 });
  }
}

async function handleRelayRequest(
  request: Request,
  route: AudioRoute,
  relayUrl: string,
  token: string,
  userId: string,
  userEmail: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    if (route.upstreamPath === "/v1/audio/artifacts/stage") {
      return await relayStage(request, relayUrl, token, userId, userEmail, fetchImpl);
    }

    const operationId = request.headers.get("x-brickhouse-operation-id") ?? undefined;
    const contentType = request.headers.get("content-type") ?? "application/json";
    const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const relayRequest = new Request(`${relayUrl}/api/request`, {
      method: "POST",
      headers: relayHeaders(token, "application/json"),
      body: JSON.stringify({
        method: request.method,
        path: route.upstreamPath,
        userId,
        userEmail,
        operationId,
        contentType,
        bodyText,
      }),
    });
    return await fetchAndSanitize(relayRequest, fetchImpl);
  } catch {
    return Response.json({ error: "Remote audio service unavailable" }, { status: 503 });
  }
}

async function relayStage(
  request: Request,
  relayUrl: string,
  token: string,
  userId: string,
  userEmail: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const sourceHash = form.get("sourceHash");
  const operationId = request.headers.get("x-brickhouse-operation-id");
  if (!(file instanceof Blob) || !file.size || !operationId || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(sourceHash)) {
    return Response.json({ error: "Invalid audio staging request" }, { status: 400 });
  }

  const totalParts = Math.ceil(file.size / RELAY_CHUNK_BYTES);
  if (totalParts < 1 || totalParts > RELAY_MAX_PARTS) {
    return Response.json({ error: "Audio staging payload too large" }, { status: 413 });
  }

  const uploadId = crypto.randomUUID();
  for (let part = 0; part < totalParts; part += 1) {
    const start = part * RELAY_CHUNK_BYTES;
    const end = Math.min(start + RELAY_CHUNK_BYTES, file.size);
    const chunk = file.slice(start, end);
    const uploadUrl = new URL(`${relayUrl}/api/upload`);
    uploadUrl.searchParams.set("uploadId", uploadId);
    uploadUrl.searchParams.set("part", String(part));
    uploadUrl.searchParams.set("total", String(totalParts));
    const uploadResponse = await fetchImpl(new Request(uploadUrl, {
      method: "PUT",
      headers: relayHeaders(token, "application/octet-stream"),
      body: chunk,
    }));
    if (!uploadResponse.ok) {
      return Response.json({ error: "Remote audio service unavailable" }, { status: 502 });
    }
  }

  const sourceName = typeof (file as File).name === "string" ? (file as File).name : "audio.bin";
  const stageRequest = new Request(`${relayUrl}/api/stage`, {
    method: "POST",
    headers: relayHeaders(token, "application/json"),
    body: JSON.stringify({
      userId,
      userEmail,
      operationId,
      uploadId,
      totalParts,
      totalBytes: file.size,
      sourceHash: sourceHash.toLowerCase(),
      sourceName,
      contentType: file.type || "application/octet-stream",
    }),
  });
  return fetchAndSanitize(stageRequest, fetchImpl);
}

function relayHeaders(token: string, contentType: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", contentType);
  return headers;
}

async function fetchAndSanitize(upstreamRequest: Request, fetchImpl: FetchLike): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamRequest);
  } catch {
    return Response.json({ error: "Remote audio service unavailable" }, { status: 503 });
  }

  if (!upstream.ok) {
    if (upstream.status === 409) {
      try {
        const payload = await upstream.json();
        return Response.json(sanitizePayload(payload), { status: 409 });
      } catch {
        return Response.json({ error: "Remote audio service unavailable" }, { status: 502 });
      }
    }
    return Response.json({ error: "Remote audio service unavailable" }, { status: 502 });
  }

  try {
    const payload = await upstream.json();
    return Response.json(sanitizePayload(payload), { status: 200 });
  } catch {
    return Response.json({ error: "Invalid audio tools response" }, { status: 502 });
  }
}

function normalizedGatewayUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELD_PATTERN.test(key))
      .map(([key, nestedValue]) => [key, sanitizePayload(nestedValue)]),
  );
}

type AudioRoute = { upstreamPath: string; mutating: boolean };

function resolveRoute(pathname: string, method: string): AudioRoute | null {
  if (pathname === "/api/audio/session" && method === "GET") {
    return { upstreamPath: "/v1/audio/session", mutating: false };
  }
  if (pathname === "/api/audio/session/source" && method === "POST") {
    return { upstreamPath: "/v1/audio/session/source", mutating: true };
  }
  if (pathname === "/api/audio/session/select" && method === "POST") {
    return { upstreamPath: "/v1/audio/session/select", mutating: true };
  }
  if (method === "POST" && pathname.startsWith("/api/audio/session/requests/") && pathname.endsWith("/fulfill")) {
    const requestId = pathname.slice("/api/audio/session/requests/".length, -"/fulfill".length);
    if (requestId && !requestId.includes("/")) return { upstreamPath: `/v1/audio/session/requests/${requestId}/fulfill`, mutating: true };
  }
  if (pathname === "/api/audio/tools" && method === "GET") {
    return { upstreamPath: "/v1/audio/tools", mutating: false };
  }
  if (pathname === "/api/audio/artifacts/stage" && method === "POST") {
    return { upstreamPath: "/v1/audio/artifacts/stage", mutating: true };
  }
  if (pathname === "/api/audio/process" && method === "POST") {
    return { upstreamPath: "/v1/audio/process", mutating: true };
  }
  if (pathname === "/api/audio/producer-loop" && method === "GET") {
    return { upstreamPath: "/v1/audio/producer-loop", mutating: false };
  }
  if (pathname === "/api/audio/producer-context" && method === "GET") {
    return { upstreamPath: "/v1/audio/producer-context", mutating: false };
  }
  if (method === "GET") {
    const candidatePage = pathname.match(/^\/api\/audio\/candidates\/([0-9]{1,3})$/);
    if (candidatePage) return { upstreamPath: `/v1/audio/candidates/${candidatePage[1]}`, mutating: false };
  }
  if (pathname === "/api/audio/library/play" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/play", mutating: true };
  }
  if (pathname === "/api/audio/library/next" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/next", mutating: true };
  }
  if (pathname === "/api/audio/library/more" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/more", mutating: true };
  }
  if (pathname === "/api/audio/library/hold" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/hold", mutating: true };
  }
  if (pathname === "/api/audio/library/bundle/add" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/bundle/add", mutating: true };
  }
  if (pathname === "/api/audio/library/bundle/remove" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/bundle/remove", mutating: true };
  }
  if (pathname === "/api/audio/library/bundle/reorder" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/bundle/reorder", mutating: true };
  }
  if (pathname === "/api/audio/library/bundle/clear" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/bundle/clear", mutating: true };
  }
  if (pathname === "/api/audio/library/choose" && method === "POST") {
    return { upstreamPath: "/v1/audio/library/choose", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/destination/verify" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/destination/verify", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/destination/clear" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/destination/clear", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/review" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/review", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/bundle/review" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/bundle/review", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/delivery/confirm" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/delivery/confirm", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/bundle/delivery/confirm" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/bundle/delivery/confirm", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/bundle/member/move" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/bundle/member/move", mutating: true };
  }
  if (pathname === "/api/audio/audiotool/delivery/undo" && method === "POST") {
    return { upstreamPath: "/v1/audio/audiotool/delivery/undo", mutating: true };
  }
  if (method === "GET" && pathname.startsWith("/api/audio/jobs/")) {
    const encodedJobId = pathname.slice("/api/audio/jobs/".length);
    if (encodedJobId && !encodedJobId.includes("/")) {
      return { upstreamPath: `/v1/audio/jobs/${encodedJobId}`, mutating: false };
    }
  }
  return null;
}

function externallyVisibleRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = (request.headers.get("host") || "").trim().toLowerCase();
  if (!host) return requestUrl.origin;
  if (host.includes(",") || /[\s/@]/.test(host)) return null;

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null) {
    const forwarded = forwardedHost.trim().toLowerCase();
    if (!forwarded || forwarded.includes(",") || forwarded !== host) return null;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = (forwardedProto ?? requestUrl.protocol.replace(/:$/, "")).trim().toLowerCase();
  if (!protocol || protocol.includes(",") || !["http", "https"].includes(protocol)) return null;

  try {
    const external = new URL(`${protocol}://${host}`);
    if (external.username || external.password || external.host.toLowerCase() !== host) return null;
    return external.origin;
  } catch {
    return null;
  }
}

function validateMutationOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return Response.json({ error: "Origin required" }, { status: 403 });
  let normalizedOrigin: string;
  try { normalizedOrigin = new URL(origin).origin; }
  catch { return Response.json({ error: "Cross-origin request blocked" }, { status: 403 }); }
  const expectedOrigin = externallyVisibleRequestOrigin(request);
  if (!expectedOrigin || normalizedOrigin !== expectedOrigin) {
    return Response.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }
  return null;
}

async function createUpstreamRequest(
  request: Request,
  url: string,
  token: string,
  userId: string,
  userEmail: string,
): Promise<Request> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-brickhouse-control-token", token);
  headers.set("x-brickhouse-user-id", userId);
  headers.set("x-brickhouse-user-email", userEmail);

  const operationId = request.headers.get("x-brickhouse-operation-id");
  if (operationId) headers.set("x-brickhouse-operation-id", operationId);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
  };

  if (new URL(request.url).pathname === "/api/audio/artifacts/stage") {
    const form = await request.formData();
    const file = form.get("file");
    const sourceHash = form.get("sourceHash");
    if (!(file instanceof Blob) || !file.size || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(sourceHash)) {
      throw new Error("Invalid staging payload");
    }
    const sourceName = typeof (file as File).name === "string" ? (file as File).name : "audio.bin";
    headers.set("content-type", file.type || "application/octet-stream");
    headers.set("x-brickhouse-source-name", sourceName);
    headers.set("x-brickhouse-source-sha256", sourceHash.toLowerCase());
    init.body = file;
    init.duplex = "half";
    return new Request(url, init);
  }

  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
