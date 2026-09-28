import { auth } from "../../../../auth";
import { handleAudioApi } from "../../../../lib/audio-api";
import { applyProducerIdentity, authorizeProducerSession, type ProducerSession } from "../../../../lib/producer-auth";

export const runtime = "nodejs";

const env = {
  BRICKHOUSE_AUDIO_RELAY_URL: process.env.BRICKHOUSE_AUDIO_RELAY_URL,
  BRICKHOUSE_AUDIO_RELAY_TOKEN: process.env.BRICKHOUSE_AUDIO_RELAY_TOKEN,
  BRICKHOUSE_AUDIO_CONTROL_URL: process.env.BRICKHOUSE_AUDIO_CONTROL_URL,
  BRICKHOUSE_AUDIO_CONTROL_TOKEN: process.env.BRICKHOUSE_AUDIO_CONTROL_TOKEN,
};

async function handler(request: Request) {
  const authorization = authorizeProducerSession(await auth() as ProducerSession);
  if (authorization.ok === false) return Response.json({ error: authorization.error }, { status: authorization.status });
  const headers = applyProducerIdentity(request.headers, authorization);
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") { init.body = request.body; init.duplex = "half"; }
  const response = await handleAudioApi(new Request(request.url, init), env);
  return response ?? Response.json({ error: "Not found" }, { status: 404 });
}

export const GET = handler;
export const POST = handler;
