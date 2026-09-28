import transportContract from "../config/audio-transport-contract.json" with { type: "json" };

type AudioTransportKind = "ordinary" | "stage";
type AudioTransportRoute = {
  id: string;
  method: string;
  pattern: string;
  transport: AudioTransportKind;
  examplePath: string;
};

const routes = (transportContract.routes as AudioTransportRoute[]).map((route) => ({
  ...route,
  regex: new RegExp(route.pattern),
}));
const routeIds = new Set(routes.map((route) => route.id));

export const AUDIO_TRANSPORT_CONTRACT_ID = transportContract.contractId;
export const AUDIO_TRANSPORT_CONTRACT_SCHEMA = transportContract.schema;
export const AUDIO_TRANSPORT_LIMITS = Object.freeze({ ...transportContract.limits });

export function hasAudioTransportRoute(routeId: string) {
  return routeIds.has(routeId);
}

export function matchAudioTransportRoute(method: string, pathname: string, transport?: AudioTransportKind) {
  if (typeof method !== "string" || typeof pathname !== "string" || pathname.includes("?")) return null;
  const normalizedMethod = method.toUpperCase();
  return routes.find((route) => (
    route.method === normalizedMethod
    && (!transport || route.transport === transport)
    && route.regex.test(pathname)
  )) ?? null;
}

export function isAllowedAudioTransportRoute(method: string, pathname: string, transport?: AudioTransportKind) {
  return matchAudioTransportRoute(method, pathname, transport) !== null;
}
