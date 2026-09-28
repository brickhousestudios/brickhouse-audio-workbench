"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveAudioProcessResult } from "../lib/audio-process-result";
import { hasAudioTransportRoute } from "../lib/audio-transport-contract";
import {
  isPreviousPlacement,
  lifecycleMatchesCurrent,
  pendingReviewMatchesCurrent,
} from "../lib/audiotool-delivery-identity";
import { analyzeBuffer, analyzeLargeWav, shouldUseLargeWavFastPath, type Analysis } from "../lib/local-audio-analysis";
import { IDLE_PRODUCER_LOOP_NODES, ProducerLoopFlow } from "./components/producer-loop-flow";
import { AuditionDeck, CustomPlayer, IntentComposer } from "./components/producer-surface";

const VOCAL_ANALYSIS_AVAILABLE = hasAudioTransportRoute("audiotool.regions") && hasAudioTransportRoute("audiotool.analyze");
const ASK_ABOUT_AUDIO_AVAILABLE = hasAudioTransportRoute("conversation.ask");

function displaySourceName(name: string): string {
  if (!name || name === "No shared source yet") return name || "No shared source yet";
  const leaf = name.split(/[\\/]/).pop() || name;
  const withoutExtension = leaf.replace(/\.(wav|aif|aiff|mp3|m4a|flac|ogg)$/i, "");
  const cleaned = withoutExtension
    .replace(/^\d{10,}-[a-f0-9]{6,}-source-/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || leaf;
}

type RemoteTool = {
  id: "split-stems" | "analyze-deeper";
  label: string;
  status: "checking" | "ready" | "unavailable";
};

type RemoteArtifact = {
  artifact_id?: string;
  name: string;
  mime_type?: string;
  bytes?: number;
};

type AudioConversationTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  route?: "measured_facts" | "transcript" | "music_reasoning" | "general_audio";
  createdAt: string;
};

type AudioConversation = {
  sourceHash: string;
  sourceRevision: number;
  selectedArtifactId: string;
  turns: AudioConversationTurn[];
  updatedAt: string;
};

type ProducerLoopNodeState = "NOT_STARTED" | "WAITING" | "RUNNING" | "NEEDS_USER" | "VERIFIED" | "PARTIAL" | "FAILED_SAFE" | "OUTCOME_UNKNOWN" | "ROLLED_BACK";

type AudiotoolDestination = {
  projectUuid: string;
  displayName?: string;
  verifiedAt: string;
  verificationEvidenceId: string;
};

type PendingDeliveryReview = {
  operationId: string;
  sourceSha256: string;
  selectedArtifactId: string;
  sourceArtifactId: string;
  projectUuid: string;
  expectedConfirmRevision: number;
  status: "NEEDS_USER";
  createdAt: string;
};

type DeliveryReceipt = {
  receiptId: string;
  operationId: string;
  sourceArtifactId: string;
  sourceSha256: string;
  selectedArtifactId: string;
  projectUuid: string;
  status: "sent" | "undone";
  created: { trackId: string; regionId: string };
  observedAt: string;
  readbackVerified: true;
  undoAvailable: boolean;
};

type DeliveryLifecycle = {
  operationId: string;
  sourceSha256: string;
  selectedArtifactId: string;
  sourceArtifactId: string;
  projectUuid: string;
  status: "APPLY_IN_FLIGHT" | "OUTCOME_UNKNOWN" | "UNDO_OUTCOME_UNKNOWN" | "VERIFIED" | "ROLLED_BACK";
  receipt: DeliveryReceipt | null;
  applyAttemptCount?: number;
};

type BundleReviewMember = {
  candidateId: string;
  artifactId: string;
  sourceSha256: string;
  name: string;
  mediaType: string;
  operationId: string;
};

type PendingBundleDeliveryReview = {
  operationId: string;
  bundleId: string;
  candidateIds: string[];
  members: BundleReviewMember[];
  projectUuid: string;
  expectedConfirmRevision: number;
  status: "NEEDS_USER";
  createdAt: string;
};

type BundleRegionShapeReceipt = {
  status: "REGION_MOVE_REMOTE_VERIFIED";
  operationId: string;
  bars: number;
  projectUuid: string;
  trackId: string;
  regionId: string;
  expectedBeforePositionTicks: number;
  beforePositionTicks: number;
  afterPositionTicks: number;
  changed: boolean;
  idempotent: boolean;
  verifiedAt: string;
};

type PendingBundleRegionShape = {
  operationId: string;
  bars: number;
  projectUuid: string;
  trackId: string;
  regionId: string;
  expectedBeforePositionTicks: number;
  targetPositionTicks: number;
  createdAt: string;
};

type BundleDeliveryMember = BundleReviewMember & {
  status: "PENDING" | "APPLY_IN_FLIGHT" | "VERIFIED" | "OUTCOME_UNKNOWN" | "FAILED_SAFE";
  receipt: DeliveryReceipt | null;
  shapeReceipts?: BundleRegionShapeReceipt[];
  pendingShape?: PendingBundleRegionShape | null;
  errorCode?: string;
};

type BundleDeliveryLifecycle = {
  operationId: string;
  bundleId: string;
  candidateIds: string[];
  projectUuid: string;
  status: "APPLY_IN_FLIGHT" | "OUTCOME_UNKNOWN" | "PARTIAL" | "FAILED_SAFE" | "VERIFIED";
  members: BundleDeliveryMember[];
  startedAt: string;
  updatedAt: string;
};

type ProducerLibraryState = {
  visiblePages: number;
  activeCandidateId: string | null;
  playback: "idle" | "playing";
  playbackEpoch: number;
  heldCandidateIds: string[];
  chosenCandidateId: string | null;
  activeBundle: { bundleId: string; candidateIds: string[]; updatedAt: string } | null;
  updatedAt: string | null;
};

type ProducerCandidate = {
  candidateId: string;
  providerId: string;
  title: string;
  bpm: number;
  key: string;
  uploader: string;
  instruments: string[];
  fitCategories: string[];
  provenanceUrl: string;
  previewAvailable: true;
  tempoDeltaBpm?: number | null;
  rankBasis?: string;
  provider?: string;
  kind?: string;
  durationSeconds?: number;
  previewUrl?: string;
  waveformUrl?: string | null;
  audiotoolSampleName?: string;
};

/** Native Audiotool catalog search (read-only). Null = the existing BrickHouse Producer Library. */
type NativeSearch = { q: string; kind: "loop" | "one-shot" | ""; bpm: string };

function nativeSearchQuery(search: NativeSearch | null): string {
  if (!search) return "";
  const params = new URLSearchParams({ provider: "audiotool", q: search.q.trim() });
  if (search.kind) params.set("kind", search.kind);
  const bpm = Number(search.bpm);
  if (Number.isFinite(bpm) && bpm > 0) { params.set("bpmMin", String(bpm - 5)); params.set("bpmMax", String(bpm + 5)); }
  return `?${params}`;
}

type SharedAudioSession = {
  revision: number;
  selectedArtifactId: string;
  source?: { sha256: string; name?: string } | null;
  sourceAvailability: "none" | "local_only" | "staged";
  stagedSourceArtifactId?: string | null;
  artifacts?: Array<{ id: string; name: string; mediaType?: string; bytes?: number }>;
  pendingRequest?: { requestId: string; operationId: string; capability: string; sourceHash: string; baseRevision: number; status: string } | null;
  producerLibrary?: ProducerLibraryState;
  audiotoolDestination?: AudiotoolDestination | null;
  pendingDeliveryReview?: PendingDeliveryReview | null;
  deliveryLifecycle?: DeliveryLifecycle | null;
  pendingBundleDeliveryReview?: PendingBundleDeliveryReview | null;
  bundleDeliveryLifecycle?: BundleDeliveryLifecycle | null;
  bundleDeliveryHistory?: BundleDeliveryLifecycle[];
  conversation?: AudioConversation | null;
};

type ProducerLoopProjection = {
  userId: string;
  revision: number;
  updatedAt: string;
  nodes: {
    source: ProducerLoopNodeState;
    understand: ProducerLoopNodeState;
    artifacts: ProducerLoopNodeState;
    select: ProducerLoopNodeState;
    destination: ProducerLoopNodeState;
    review: ProducerLoopNodeState;
    send: ProducerLoopNodeState;
    verify: ProducerLoopNodeState;
    receipt: ProducerLoopNodeState;
    undo: ProducerLoopNodeState;
  };
};

type WebMcpContext = {
  registerTool(
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute(input: unknown): unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): void | Promise<void>;
};

type AudioActionResult =
  | { ok: true; session: SharedAudioSession }
  | { ok: false; error: string };

type AudioWorkbenchWebMcpActions = {
  getState(): Promise<Record<string, unknown>>;
  listTools(): Promise<Record<string, unknown>>;
  runTool(capability: RemoteTool["id"]): Promise<Record<string, unknown>>;
  listArtifacts(): Promise<Record<string, unknown>>;
  selectArtifact(artifactId: string): Promise<Record<string, unknown>>;
  getDeliveryStatus(): Promise<Record<string, unknown>>;
  startDeliveryReview(): Promise<Record<string, unknown>>;
};

function summarizeSession(session: SharedAudioSession) {
  return {
    revision: session.revision,
    source: session.source ? { sha256: session.source.sha256, name: session.source.name || null } : null,
    sourceAvailability: session.sourceAvailability,
    selectedArtifactId: session.selectedArtifactId,
    producerLibrary: session.producerLibrary ? {
      visiblePages: session.producerLibrary.visiblePages,
      activeCandidateId: session.producerLibrary.activeCandidateId,
      playback: session.producerLibrary.playback,
      playbackEpoch: session.producerLibrary.playbackEpoch,
      heldCandidateIds: [...session.producerLibrary.heldCandidateIds],
      chosenCandidateId: session.producerLibrary.chosenCandidateId,
      activeBundle: session.producerLibrary.activeBundle ? {
        bundleId: session.producerLibrary.activeBundle.bundleId,
        candidateIds: [...session.producerLibrary.activeBundle.candidateIds],
        updatedAt: session.producerLibrary.activeBundle.updatedAt,
      } : null,
      updatedAt: session.producerLibrary.updatedAt,
    } : null,
    pendingRequest: session.pendingRequest ? {
      requestId: session.pendingRequest.requestId,
      capability: session.pendingRequest.capability,
      sourceHash: session.pendingRequest.sourceHash,
      baseRevision: session.pendingRequest.baseRevision,
      status: session.pendingRequest.status,
    } : null,
    audiotoolDestination: session.audiotoolDestination ? {
      projectUuid: session.audiotoolDestination.projectUuid,
      ...(session.audiotoolDestination.displayName ? { displayName: session.audiotoolDestination.displayName } : {}),
      verifiedAt: session.audiotoolDestination.verifiedAt,
      verificationEvidenceId: session.audiotoolDestination.verificationEvidenceId,
    } : null,
    pendingDeliveryReview: session.pendingDeliveryReview ? {
      operationId: session.pendingDeliveryReview.operationId,
      sourceSha256: session.pendingDeliveryReview.sourceSha256,
      selectedArtifactId: session.pendingDeliveryReview.selectedArtifactId,
      sourceArtifactId: session.pendingDeliveryReview.sourceArtifactId,
      projectUuid: session.pendingDeliveryReview.projectUuid,
      expectedConfirmRevision: session.pendingDeliveryReview.expectedConfirmRevision,
      status: session.pendingDeliveryReview.status,
      createdAt: session.pendingDeliveryReview.createdAt,
    } : null,
    deliveryLifecycle: session.deliveryLifecycle ? {
      operationId: session.deliveryLifecycle.operationId,
      sourceSha256: session.deliveryLifecycle.sourceSha256,
      selectedArtifactId: session.deliveryLifecycle.selectedArtifactId,
      sourceArtifactId: session.deliveryLifecycle.sourceArtifactId,
      projectUuid: session.deliveryLifecycle.projectUuid,
      status: session.deliveryLifecycle.status,
      applyAttemptCount: session.deliveryLifecycle.applyAttemptCount,
      receipt: session.deliveryLifecycle.receipt ? { ...session.deliveryLifecycle.receipt } : null,
    } : null,
    pendingBundleDeliveryReview: session.pendingBundleDeliveryReview ? {
      operationId: session.pendingBundleDeliveryReview.operationId,
      bundleId: session.pendingBundleDeliveryReview.bundleId,
      candidateIds: [...session.pendingBundleDeliveryReview.candidateIds],
      members: session.pendingBundleDeliveryReview.members.map((member) => ({ ...member })),
      projectUuid: session.pendingBundleDeliveryReview.projectUuid,
      expectedConfirmRevision: session.pendingBundleDeliveryReview.expectedConfirmRevision,
      status: session.pendingBundleDeliveryReview.status,
      createdAt: session.pendingBundleDeliveryReview.createdAt,
    } : null,
    bundleDeliveryLifecycle: session.bundleDeliveryLifecycle ? {
      operationId: session.bundleDeliveryLifecycle.operationId,
      bundleId: session.bundleDeliveryLifecycle.bundleId,
      candidateIds: [...session.bundleDeliveryLifecycle.candidateIds],
      projectUuid: session.bundleDeliveryLifecycle.projectUuid,
      status: session.bundleDeliveryLifecycle.status,
      members: session.bundleDeliveryLifecycle.members.map((member) => ({
        ...member,
        receipt: member.receipt ? { ...member.receipt } : null,
        shapeReceipts: member.shapeReceipts?.map((receipt) => ({ ...receipt })) || [],
        pendingShape: member.pendingShape ? { ...member.pendingShape } : null,
      })),
      startedAt: session.bundleDeliveryLifecycle.startedAt,
      updatedAt: session.bundleDeliveryLifecycle.updatedAt,
    } : null,
  };
}

function pendingBundleReviewMatchesCurrent(session: SharedAudioSession) {
  const pending = session.pendingBundleDeliveryReview;
  const bundle = session.producerLibrary?.activeBundle;
  const destination = session.audiotoolDestination;
  return Boolean(
    pending?.status === "NEEDS_USER"
    && bundle
    && destination
    && pending.expectedConfirmRevision === session.revision
    && pending.bundleId === bundle.bundleId
    && pending.projectUuid === destination.projectUuid
    && pending.candidateIds.length === bundle.candidateIds.length
    && pending.candidateIds.every((candidateId, index) => candidateId === bundle.candidateIds[index]),
  );
}

function selectedArtifactLabel(session: SharedAudioSession) {
  if (session.selectedArtifactId === "original") return "Original";
  const found = (session.artifacts || []).find((artifact) => artifact.id === session.selectedArtifactId);
  return found?.name || session.selectedArtifactId;
}

function summarizeArtifacts(session: SharedAudioSession) {
  return [
    { id: "original", name: "Original", mediaType: null, bytes: null },
    ...(session.artifacts || []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      mediaType: artifact.mediaType || null,
      bytes: artifact.bytes ?? null,
    })),
  ];
}


type AudiotoolRegion = {
  regionId: string;
  displayName: string | null;
  durationSeconds: number | null;
};

type VocalAnalysisResult = {
  status: "ANALYZED_REMOTE_VERIFIED";
  projectUuid: string;
  regionId: string;
  displayName: string | null;
  durationSeconds: number | null;
  sourceSha256: string;
  bytes: number;
  analyzedAt: string;
  acoustics: Record<string, unknown>;
  notes: Record<string, unknown>;
  halves: Record<string, unknown>;
};

function nestedNumber(value: Record<string, unknown> | undefined, ...path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  const number = Number(current);
  return Number.isFinite(number) ? number : null;
}

type ToolPhase = "verifying" | "staging" | "processing" | null;
type DeliveryPhase = "idle" | "sending" | "verifying" | "undoing" | "verifying_undo" | "error";

const initialTools: RemoteTool[] = [
  { id: "split-stems", label: "Split Stems", status: "checking" },
  { id: "analyze-deeper", label: "Analyze Deeper", status: "unavailable" },
];

async function sha256File(file: File, bytes?: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes ?? await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function artifactLabel(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("vocals")) return "Vocals";
  if (lower.includes("instrumental")) return "Instrumental";
  if (lower.includes("analysis")) return "Analysis";
  return name;
}

function suggestions(a: Analysis) {
  const eq = ["HPF 80 Hz · Q 0.707 · verify by ear"];
  if (a.balance.mud > 0.18) eq.push("Bell 280 Hz · −2.0 dB · Q 1.1");
  if (a.balance.box > 0.17) eq.push("Bell 650 Hz · −1.5 dB · Q 1.2");
  if (a.balance.harsh > 0.16) eq.push("Bell 5.6 kHz · −1.5 dB · Q 2.0");
  if (a.balance.air < 0.06 && a.sampleRate >= 32000) eq.push("High shelf 12 kHz · +1.0 dB · verify noise floor");
  const harsh = a.balance.harsh || 0;
  const air = a.balance.air || 0;
  const deesser = {
    frequency: harsh >= air ? 6800 : 7600,
    range: harsh > 0.2 ? 5 : harsh > 0.13 ? 3.5 : 2,
    threshold: Math.max(-36, Math.min(-18, a.rmsDb + 10)),
  };
  return { eq, deesser };
}

export default function Home() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sourceHash, setSourceHash] = useState("");
  const [tools, setTools] = useState<RemoteTool[]>(initialTools);
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [toolPhase, setToolPhase] = useState<ToolPhase>(null);
  const [toolError, setToolError] = useState("");
  const [remoteArtifacts, setRemoteArtifacts] = useState<RemoteArtifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState("original");
  const [libraryCandidates, setLibraryCandidates] = useState<ProducerCandidate[]>([]);
  const [nativeSearch, setNativeSearch] = useState<NativeSearch | null>(null);
  const [nativeDraft, setNativeDraft] = useState<NativeSearch>({ q: "", kind: "loop", bpm: "" });
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryPlaybackBlockedCandidateId, setLibraryPlaybackBlockedCandidateId] = useState<string | null>(null);
  const [sharedSession, setSharedSession] = useState<SharedAudioSession | null>(null);
  const [producerLoop, setProducerLoop] = useState<ProducerLoopProjection | null>(null);
  const [producerLoopStatus, setProducerLoopStatus] = useState<"loading" | "live" | "error" | "unverified">("loading");
  const [destinationUuidInput, setDestinationUuidInput] = useState("");
  const [destinationDisplayName, setDestinationDisplayName] = useState<string | null>(null);
  const [deliveryReview, setDeliveryReview] = useState(false);
  const [deliveryPhase, setDeliveryPhase] = useState<DeliveryPhase>("idle");
  const [deliveryError, setDeliveryError] = useState("");
  const [regionShapeBusy, setRegionShapeBusy] = useState<string | null>(null);
  const [audiotoolRegions, setAudiotoolRegions] = useState<AudiotoolRegion[]>([]);
  const [selectedVocalRegionId, setSelectedVocalRegionId] = useState("");
  const [vocalAnalysis, setVocalAnalysis] = useState<VocalAnalysisResult | null>(null);
  const [vocalAnalysisBusy, setVocalAnalysisBusy] = useState(false);
  const [vocalAnalysisError, setVocalAnalysisError] = useState("");
  const [audioQuestion, setAudioQuestion] = useState("");
  const [intent, setIntent] = useState("");
  const [intentBusy, setIntentBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [sourceObjectUrl, setSourceObjectUrl] = useState<string | null>(null);
  const [audioAskBusy, setAudioAskBusy] = useState(false);
  const [audioAskError, setAudioAskError] = useState("");
  const [researchAudioApproved, setResearchAudioApproved] = useState(false);
  const researchApprovalSourceHash = useRef<string | null>(null);
  const fulfillingRequestId = useRef<string | null>(null);
  const sessionPollInFlight = useRef(false);
  const libraryAudioRefs = useRef(new Map<string, HTMLAudioElement>());
  const pendingLibraryOperationRef = useRef<{ key: string; operationId: string } | null>(null);
  const handledLibraryPlaybackEpoch = useRef(0);
  const webMcpActionsRef = useRef<AudioWorkbenchWebMcpActions | null>(null);
  const recs = useMemo(() => analysis ? suggestions(analysis) : null, [analysis]);
  const sessionLabel = sessionError
    ? "SESSION UNAVAILABLE"
    : sharedSession
      ? "SHARED SESSION"
      : sourceFile ? "CONNECTING" : "LOCAL ANALYSIS";
  const privacyLabel = sharedSession?.sourceAvailability === "staged"
    ? "SOURCE STAGED PRIVATELY"
    : toolPhase === "staging"
      ? "STAGING EXACT SOURCE"
      : "AUDIO BYTES LOCAL ONLY";
  const activeOperation = sharedSession?.pendingRequest?.status === "pending"
    ? { actor: "Agent", label: `Agent requested ${sharedSession.pendingRequest.capability === "split-stems" ? "Split Stems" : sharedSession.pendingRequest.capability}`, phase: toolPhase || "waiting for matching local source" }
    : toolBusy
      ? { actor: "Producer", label: toolBusy === "split-stems" ? "Split Stems" : toolBusy, phase: toolPhase || "working" }
      : null;
  const hasSharedSource = Boolean(sharedSession?.source);
  const hasSource = Boolean(sourceFile || sharedSession?.source);
  const hasRunnableSource = Boolean(sourceFile || (sharedSession?.sourceAvailability === "staged" && sharedSession?.stagedSourceArtifactId));
  const currentSourceName = analysis?.name || sourceFile?.name || sharedSession?.source?.name || "No shared source yet";
  const currentSourceDisplayName = displaySourceName(currentSourceName);
  const stemArtifacts = remoteArtifacts.filter((artifact) => ["vocals.wav", "instrumental.wav"].includes(artifact.name.toLowerCase()));
  const lifecycle = sharedSession?.deliveryLifecycle || null;
  const bundleLifecycle = sharedSession?.bundleDeliveryLifecycle || null;
  const lifecycleIsCurrent = sharedSession ? lifecycleMatchesCurrent(sharedSession) : false;
  const singleApplyInFlight = lifecycle?.status === "APPLY_IN_FLIGHT";
  const bundleApplyInFlight = bundleLifecycle?.status === "APPLY_IN_FLIGHT";
  const applyInFlight = singleApplyInFlight || bundleApplyInFlight;
  const outcomeUnknown = lifecycle?.status === "OUTCOME_UNKNOWN";
  const bundleOutcomeUnknown = bundleLifecycle?.status === "OUTCOME_UNKNOWN";
  const undoOutcomeUnknown = lifecycle?.status === "UNDO_OUTCOME_UNKNOWN";
  const verifiedDelivery = lifecycleIsCurrent && lifecycle?.status === "VERIFIED" && producerLoop?.nodes.verify === "VERIFIED" ? lifecycle : null;
  const rolledBackDelivery = lifecycleIsCurrent && lifecycle?.status === "ROLLED_BACK" && producerLoop?.nodes.undo === "ROLLED_BACK" ? lifecycle : null;
  const previousPlacement = sharedSession ? (isPreviousPlacement(sharedSession) || Boolean(lifecycle?.receipt && producerLoop && producerLoop.nodes.verify !== "VERIFIED" && lifecycle?.status === "VERIFIED")) : false;
  const pendingReview = sharedSession?.pendingDeliveryReview?.status === "NEEDS_USER" ? sharedSession.pendingDeliveryReview : null;
  const pendingReviewCurrent = Boolean(sharedSession && pendingReviewMatchesCurrent(sharedSession));
  const stalePendingReview = Boolean(pendingReview && !pendingReviewCurrent);
  const verifiedDestination = sharedSession?.audiotoolDestination || null;
  const destinationLabel = verifiedDestination?.displayName || destinationDisplayName || (verifiedDestination ? "Audiotool project" : "No verified project");
  const libraryState = sharedSession?.producerLibrary || {
    visiblePages: 1,
    activeCandidateId: null,
    playback: "idle" as const,
    playbackEpoch: 0,
    heldCandidateIds: [],
    chosenCandidateId: null,
    activeBundle: null,
    updatedAt: null,
  };
  const bundleCandidateIds = libraryState.activeBundle?.candidateIds || [];
  const bundleCandidates = bundleCandidateIds.map((candidateId) => ({
    candidateId,
    candidate: libraryCandidates.find((entry) => entry.candidateId === candidateId) || null,
  }));
  const pendingBundleReview = sharedSession?.pendingBundleDeliveryReview?.status === "NEEDS_USER"
    ? sharedSession.pendingBundleDeliveryReview
    : null;
  const pendingBundleReviewCurrent = Boolean(
    sharedSession
    && pendingBundleReview
    && pendingBundleReview.expectedConfirmRevision === sharedSession.revision
    && pendingBundleReview.bundleId === libraryState.activeBundle?.bundleId
    && pendingBundleReview.projectUuid === sharedSession.audiotoolDestination?.projectUuid
    && pendingBundleReview.candidateIds.length === bundleCandidateIds.length
    && pendingBundleReview.candidateIds.every((candidateId, index) => candidateId === bundleCandidateIds[index]),
  );
  const bundleVerifiedCount = bundleLifecycle?.members.filter((member) => member.status === "VERIFIED").length || 0;
  const bundleFailedCount = bundleLifecycle?.members.filter((member) => member.status === "FAILED_SAFE").length || 0;
  const bundleUnknownCount = bundleLifecycle?.members.filter((member) => member.status === "OUTCOME_UNKNOWN").length || 0;

  const renderSettledBundleMember = (member: BundleDeliveryMember, index: number) => {
    const latestShape = member.shapeReceipts?.at(-1) || null;
    const pendingShape = member.pendingShape || null;
    const shapeBusy = regionShapeBusy === member.operationId;
    const memberLabel = libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name;
    const statusLabel = member.status === "VERIFIED"
      ? "Placed & verified"
      : member.status === "FAILED_SAFE"
        ? "Stopped safely"
        : member.status === "OUTCOME_UNKNOWN"
          ? "Needs reconciliation"
          : member.status === "APPLY_IN_FLIGHT"
            ? "Placing…"
            : "Waiting";
    return <li key={member.operationId}>
      <span>{index + 1}. {memberLabel}</span>
      <strong>{statusLabel}</strong>
      {member.receipt && <small>Verified in Audiotool</small>}
      {latestShape && <small className="bundleShapeReceipt">Moved {latestShape.bars > 0 ? "+" : ""}{latestShape.bars} {Math.abs(latestShape.bars) === 1 ? "bar" : "bars"} · verified</small>}
      {member.errorCode && member.status !== "VERIFIED" && <small>{member.errorCode}</small>}
      {pendingShape ? (
        <div className="bundleShapeActions">
          <span>Move needs reconciliation: {pendingShape.bars > 0 ? "+" : ""}{pendingShape.bars} {Math.abs(pendingShape.bars) === 1 ? "bar" : "bars"}</span>
          <button type="button" disabled={Boolean(regionShapeBusy)} onClick={() => void moveBundleMemberByBars(member.operationId, pendingShape.bars)}>{shapeBusy ? "Reconciling…" : "Reconcile move"}</button>
        </div>
      ) : member.status === "VERIFIED" && member.receipt ? (
        <div className="bundleShapeActions" aria-label={`Move ${memberLabel} in Audiotool`}>
          <span>Move in Audiotool</span>
          <button type="button" disabled={Boolean(regionShapeBusy)} onClick={() => void moveBundleMemberByBars(member.operationId, -1)}>{shapeBusy ? "Moving…" : "−1 bar"}</button>
          <button type="button" disabled={Boolean(regionShapeBusy)} onClick={() => void moveBundleMemberByBars(member.operationId, 1)}>{shapeBusy ? "Moving…" : "+1 bar"}</button>
        </div>
      ) : null}
    </li>;
  };

  useEffect(() => {
    let active = true;
    fetch("/api/audio/tools")
      .then(async (response) => {
        if (!response.ok) throw new Error("tools unavailable");
        return response.json();
      })
      .then((payload) => {
        if (!active || !Array.isArray(payload.tools)) return;
        const next = initialTools.map((tool) => {
          const live = payload.tools.find((item: RemoteTool) => item.id === tool.id);
          return live ? { ...tool, status: live.status === "ready" ? "ready" as const : "unavailable" as const } : { ...tool, status: "unavailable" as const };
        });
        setTools(next);
      })
      .catch(() => active && setTools(initialTools.map((tool) => ({ ...tool, status: "unavailable" }))));
    return () => { active = false; };
  }, []);

  const refreshProducerLoop = useCallback(async (): Promise<ProducerLoopProjection | null> => {
    try {
      const response = await fetch("/api/audio/producer-loop", { cache: "no-store" });
      if (!response.ok) {
        setProducerLoop(null);
        setProducerLoopStatus("error");
        return null;
      }
      const payload = await response.json();
      const next = payload.producerLoop as ProducerLoopProjection | undefined;
      if (next) {
        setProducerLoop(next);
        setProducerLoopStatus("live");
        return next;
      }
      setProducerLoop(null);
      setProducerLoopStatus("unverified");
      return null;
    } catch {
      setProducerLoop(null);
      setProducerLoopStatus("error");
      return null;
    }
  }, []);

  const hydrateSharedSession = useCallback((session: SharedAudioSession) => {
    setSessionError("");
    const nextSourceHash = session.source?.sha256 || null;
    if (researchApprovalSourceHash.current && researchApprovalSourceHash.current !== nextSourceHash) setResearchAudioApproved(false);
    researchApprovalSourceHash.current = nextSourceHash;
    setSharedSession(session);
    setSourceHash(session.source?.sha256 || "");
    setSelectedArtifactId(session.selectedArtifactId || "original");
    if (session.producerLibrary?.chosenCandidateId) {
      setSourceFile(null);
      setAnalysis(null);
    }
    const sharedArtifacts = Array.isArray(session.artifacts) ? session.artifacts : [];
    setRemoteArtifacts(sharedArtifacts.map((artifact) => ({
      artifact_id: artifact.id,
      name: artifact.name,
      mime_type: artifact.mediaType,
      bytes: artifact.bytes,
    })));
    setDestinationDisplayName(session.audiotoolDestination?.displayName || null);
    if (session.pendingDeliveryReview?.status === "NEEDS_USER") setDeliveryReview(true);
    void refreshProducerLoop();
    return session;
  }, [refreshProducerLoop]);

  const refreshSharedSession = useCallback(async () => {
    const response = await fetch("/api/audio/session", { cache: "no-store" });
    if (!response.ok) throw new Error("shared session unavailable");
    const payload = await response.json();
    return hydrateSharedSession(payload.session as SharedAudioSession);
  }, [hydrateSharedSession]);

  useEffect(() => {
    if (!sourceFile) {
      setSourceObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    setSourceObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  useEffect(() => {
    let active = true;
    void refreshSharedSession().catch(() => {
      if (active) setSessionError("Shared session unavailable. Local analysis still works, but agent cannot jump in yet.");
    });
    return () => { active = false; };
  }, [refreshSharedSession]);

  const refreshLibraryCandidates = useCallback(async (visiblePages: number) => {
    setLibraryError("");
    const seen = new Set<string>();
    const candidates: ProducerCandidate[] = [];
    let failedPages = 0;
    for (let page = 0; page < Math.max(1, visiblePages); page += 1) {
      try {
        const response = await fetch(`/api/audio/candidates/${page}${nativeSearchQuery(nativeSearch)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Producer Library page ${page + 1} unavailable.`);
        const payload = await response.json();
        const pageCandidates = Array.isArray(payload.candidates) ? payload.candidates as ProducerCandidate[] : [];
        for (const candidate of pageCandidates) {
          if (!candidate?.candidateId || seen.has(candidate.candidateId)) continue;
          seen.add(candidate.candidateId);
          candidates.push(candidate);
        }
        setLibraryCandidates([...candidates]);
      } catch {
        failedPages += 1;
      }
    }
    if (candidates.length === 0 && failedPages > 0) {
      setLibraryCandidates([]);
      setLibraryError(nativeSearch ? "Audiotool sample search is temporarily unavailable." : "Producer Library is temporarily unavailable.");
    }
  }, [nativeSearch]);

  useEffect(() => {
    if (!sharedSession) return;
    void refreshLibraryCandidates(sharedSession.producerLibrary?.visiblePages || 1);
  }, [sharedSession?.producerLibrary?.visiblePages, verifiedDestination?.projectUuid, refreshLibraryCandidates]);

  function libraryOperationId(key: string) {
    const pending = pendingLibraryOperationRef.current;
    if (pending?.key === key) return pending.operationId;
    const operationId = crypto.randomUUID();
    pendingLibraryOperationRef.current = { key, operationId };
    return operationId;
  }

  async function runLibraryAction(action: "play" | "next" | "more" | "hold", candidateId?: string) {
    if (!sharedSession || libraryBusy) return;
    const operationKey = `${action}:${candidateId || ""}`;
    const operationId = libraryOperationId(operationKey);
    setLibraryBusy(true);
    setLibraryError("");
    {
      const targetTitle = candidateId ? libraryCandidates.find((entry) => entry.candidateId === candidateId)?.title : null;
      if (action === "next") {
        setAnnounce("Next. Loading the next choice.");
      } else if (action === "more") {
        setAnnounce("Loading more choices.");
      }
      else if (action === "play" && targetTitle) setAnnounce(`Playing ${targetTitle}.`);
      else if (action === "hold" && candidateId) {
        const wasHeld = libraryState.heldCandidateIds.includes(candidateId);
        setAnnounce(wasHeld ? `Removed ${targetTitle || "candidate"} from kept sounds.` : `Kept ${targetTitle || "candidate"}.`);
      }
    }
    try {
      const current = await refreshSharedSession();
      const response = await fetch(`/api/audio/library/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({ expectedRevision: current.revision, ...(candidateId ? { candidateId } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.session) throw new Error(payload.error || `Producer Library ${action} failed.`);
      hydrateSharedSession(payload.session as SharedAudioSession);
      if (pendingLibraryOperationRef.current?.operationId === operationId) pendingLibraryOperationRef.current = null;
    } catch (failure) {
      setLibraryError(failure instanceof Error ? failure.message : `Producer Library ${action} failed.`);
    } finally {
      setLibraryBusy(false);
    }
  }

  async function runBundleAction(action: "add" | "remove" | "clear", candidateId?: string) {
    if (!sharedSession || libraryBusy) return;
    const operationKey = `bundle:${action}:${candidateId || ""}`;
    const operationId = libraryOperationId(operationKey);
    setLibraryBusy(true);
    setLibraryError("");
    try {
      const current = await refreshSharedSession();
      const response = await fetch(`/api/audio/library/bundle/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({ expectedRevision: current.revision, ...(candidateId ? { candidateId } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.session) throw new Error(payload.error || `Producer Library Bundle ${action} failed.`);
      const session = hydrateSharedSession(payload.session as SharedAudioSession);
      const title = candidateId ? libraryCandidates.find((entry) => entry.candidateId === candidateId)?.title || "candidate" : null;
      if (action === "add") setAnnounce(`Added ${title} to Bundle.`);
      else if (action === "remove") setAnnounce(`Removed ${title} from Bundle.`);
      else setAnnounce("Cleared Bundle.");
      if (pendingLibraryOperationRef.current?.operationId === operationId) pendingLibraryOperationRef.current = null;
      return session;
    } catch (failure) {
      setLibraryError(failure instanceof Error ? failure.message : `Producer Library Bundle ${action} failed.`);
      return null;
    } finally {
      setLibraryBusy(false);
    }
  }

  async function chooseLibraryCandidate(candidateId: string) {
    if (!sharedSession || libraryBusy) return;
    const operationKey = `choose:${candidateId}`;
    const operationId = libraryOperationId(operationKey);
    setLibraryBusy(true);
    setLibraryError("");
    {
      const targetTitle = libraryCandidates.find((entry) => entry.candidateId === candidateId)?.title || "candidate";
      setAnnounce(`Using ${targetTitle}. Staging it as the source. Nothing is sent.`);
    }
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/library/choose", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({ expectedRevision: current.revision, candidateId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.session) throw new Error(payload.error || "Producer Library choose failed.");
      hydrateSharedSession(payload.session as SharedAudioSession);
      if (pendingLibraryOperationRef.current?.operationId === operationId) pendingLibraryOperationRef.current = null;
    } catch (failure) {
      setLibraryError(failure instanceof Error ? failure.message : "Producer Library choose failed.");
    } finally {
      setLibraryBusy(false);
    }
  }

  useEffect(() => {
    const state = sharedSession?.producerLibrary;
    if (!state || state.playback !== "playing" || !state.activeCandidateId || state.playbackEpoch <= handledLibraryPlaybackEpoch.current) return;
    const player = libraryAudioRefs.current.get(state.activeCandidateId);
    if (!player) return;
    for (const [candidateId, audio] of libraryAudioRefs.current) {
      if (candidateId !== state.activeCandidateId) audio.pause();
    }
    player.currentTime = 0;
    void player.play().then(() => {
      handledLibraryPlaybackEpoch.current = state.playbackEpoch;
      setLibraryPlaybackBlockedCandidateId(null);
    }).catch(() => {
      handledLibraryPlaybackEpoch.current = state.playbackEpoch;
      setLibraryPlaybackBlockedCandidateId(state.activeCandidateId);
      setAnnounce("Playback is ready. Press Play on the active choice to hear it.");
    });
  }, [sharedSession?.producerLibrary?.playbackEpoch, sharedSession?.producerLibrary?.activeCandidateId, libraryCandidates]);

  async function publishSharedSource(file: File, measured: Analysis | null, sha256: string) {
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/session/source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({
          expectedRevision: current.revision,
          source: { name: file.name, mediaType: file.type || "application/octet-stream", bytes: file.size, sha256, ...(measured ? { duration: measured.duration, sampleRate: measured.sampleRate, channels: measured.channels } : {}) },
          ...(measured ? { analysis: { peakDb: measured.peakDb, rmsDb: measured.rmsDb, crestDb: measured.crestDb, zcr: measured.zcr, balance: measured.balance, flags: measured.flags } } : {}),
        }),
      });
      if (!response.ok) throw new Error("Shared session could not accept this source descriptor.");
      const payload = await response.json();
      return hydrateSharedSession(payload.session as SharedAudioSession);
    } catch {
      setSessionError("Shared session unavailable. Local analysis still works, but agent cannot jump in yet.");
      return null;
    }
  }

  const fulfillPendingAgentRequest = useCallback(async (session: SharedAudioSession) => {
    const pendingRequest = session.pendingRequest;
    if (!sourceFile || !pendingRequest || pendingRequest.status !== "pending") return;
    if (fulfillingRequestId.current === pendingRequest.requestId) return;
    fulfillingRequestId.current = pendingRequest.requestId;
    setToolError("");
    setToolPhase("verifying");
    try {
      const loadedHash = await sha256File(sourceFile);
      if (loadedHash !== pendingRequest.sourceHash) {
        setToolError("The loaded source changed, so the agent request was not fulfilled.");
        return;
      }
      const beforeStage = await refreshSharedSession();
      if (beforeStage.pendingRequest?.requestId !== pendingRequest.requestId ||
          beforeStage.pendingRequest?.operationId !== pendingRequest.operationId ||
          beforeStage.pendingRequest?.sourceHash !== loadedHash ||
          beforeStage.source?.sha256 !== loadedHash) {
        setToolError("The shared source changed, so the agent request was not fulfilled.");
        return;
      }

      let artifactId = beforeStage.sourceAvailability === "staged" ? beforeStage.stagedSourceArtifactId || undefined : undefined;
      if (!artifactId) {
        setToolPhase("staging");
        const stageForm = new FormData();
        stageForm.set("file", sourceFile);
        stageForm.set("sourceHash", loadedHash);
        const stageResponse = await fetch("/api/audio/artifacts/stage", {
          method: "POST",
          headers: { "x-brickhouse-operation-id": pendingRequest.operationId },
          body: stageForm,
        });
        if (!stageResponse.ok) throw new Error("Could not stage the selected audio privately.");
        const staged = await stageResponse.json();
        artifactId = staged.artifact?.artifact_id || staged.artifactId;
        if (!artifactId) throw new Error("The staged audio did not return an artifact ID.");
        if (staged.session) hydrateSharedSession(staged.session as SharedAudioSession);
      }

      setToolPhase("verifying");
      const beforeProcess = await refreshSharedSession();
      if (beforeProcess.pendingRequest?.requestId !== pendingRequest.requestId ||
          beforeProcess.pendingRequest?.operationId !== pendingRequest.operationId ||
          beforeProcess.pendingRequest?.sourceHash !== loadedHash ||
          beforeProcess.source?.sha256 !== loadedHash ||
          beforeProcess.stagedSourceArtifactId !== artifactId) {
        setToolError("The shared source changed before processing, so the agent request was not fulfilled.");
        return;
      }

      setToolPhase("processing");
      const processResponse = await fetch("/api/audio/process", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": pendingRequest.operationId },
        body: JSON.stringify({ artifactId, capability: pendingRequest.capability }),
      });
      if (!processResponse.ok) throw new Error("The requested BrickHouse tool could not complete.");
      const processed = await processResponse.json();
      const processedSession = await resolveAudioProcessResult<SharedAudioSession>(processed, {
        pollAudioJob,
        hydrateSharedSession,
        refreshSharedSession,
        setRemoteArtifacts: (artifacts) => setRemoteArtifacts(artifacts as RemoteArtifact[]),
        setSelectedArtifactId,
      });

      const fulfillResponse = await fetch(`/api/audio/session/requests/${pendingRequest.requestId}/fulfill`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": pendingRequest.operationId },
        body: JSON.stringify({ expectedRevision: processedSession.revision, sourceHash: loadedHash, artifactId }),
      });
      if (!fulfillResponse.ok) throw new Error("The completed agent request could not be verified against the shared session.");
      const fulfilled = await fulfillResponse.json();
      if (fulfilled.session) hydrateSharedSession(fulfilled.session as SharedAudioSession);
    } catch (requestFailure) {
      setToolError(requestFailure instanceof Error ? requestFailure.message : "Agent audio request failed.");
    } finally {
      setToolPhase(null);
      fulfillingRequestId.current = null;
    }
  }, [sourceFile, hydrateSharedSession, refreshSharedSession]);

  useEffect(() => {
    if (busy || toolBusy || libraryBusy) return;
    let active = true;
    const refresh = async () => {
      if (sessionPollInFlight.current) return;
      sessionPollInFlight.current = true;
      try {
        const response = await fetch("/api/audio/session", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (!active || !payload.session) return;
        const session = hydrateSharedSession(payload.session as SharedAudioSession);
        if (sourceFile && session.pendingRequest?.status === "pending") await fulfillPendingAgentRequest(session);
      } catch { /* local analysis remains usable */ }
      finally { sessionPollInFlight.current = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [sourceFile, hydrateSharedSession, fulfillPendingAgentRequest, busy, toolBusy, libraryBusy]);

  async function selectSharedArtifact(artifactId: string): Promise<AudioActionResult> {
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/session/select", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: current.revision, artifactId }),
      });
      if (!response.ok) throw new Error("Could not update the shared output selection.");
      const payload = await response.json();
      const session = hydrateSharedSession(payload.session as SharedAudioSession);
      return { ok: true, session };
    } catch (selectionFailure) {
      const message = selectionFailure instanceof Error ? selectionFailure.message : "Shared output selection failed.";
      setToolError(message);
      return { ok: false, error: message };
    }
  }

  async function loadAudioFile(file: File) {
    setSourceFile(file);
    setRemoteArtifacts([]);
    setSelectedArtifactId("original");
    setToolError("");
    setSessionError("");
    setSourceHash("");
    setBusy(true); setError("");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const bytes = await file.arrayBuffer();
      const sha256 = await sha256File(file, bytes);
      let measured: Analysis;
      if (shouldUseLargeWavFastPath(file.name, file.size)) {
        measured = analyzeLargeWav(file.name, bytes);
      } else {
        const ctx = new AudioContext();
        try {
          const buffer = await ctx.decodeAudioData(bytes);
          measured = analyzeBuffer(file.name, buffer);
        } finally {
          await ctx.close();
        }
      }
      setAnalysis(measured);
      setSourceHash(sha256);
      await publishSharedSource(file, measured, sha256);
    } catch {
      setAnalysis(null);
      setError("Could not decode that audio file in this browser. Try WAV, AIFF, MP3, M4A, or another browser-supported format.");
    } finally { setBusy(false); }
  }

  function pickAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void loadAudioFile(file);
  }

  function handleAudioDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleAudioDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void loadAudioFile(file);
  }

  async function pollAudioJob(jobId: string): Promise<SharedAudioSession> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await fetch(`/api/audio/jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not read BrickHouse job status.");
      const body = await response.json();
      const status = String(body.job?.status || "");
      if (status === "succeeded") {
        const current = await refreshSharedSession();
        if (current.artifacts?.length) hydrateSharedSession(current);
        else {
          const outputs = Array.isArray(body.artifacts) ? body.artifacts : [];
          setRemoteArtifacts(outputs);
          setSelectedArtifactId("original");
        }
        return current;
      }
      if (status === "failed") throw new Error("The selected BrickHouse tool failed. Please retry once.");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("BrickHouse processing is still running. Refresh to check the shared results.");
  }

  async function runAudioTool(capability: RemoteTool["id"]): Promise<AudioActionResult> {
    const tool = tools.find((item) => item.id === capability);
    if (!sharedSession || tool?.status !== "ready" || toolBusy || !hasRunnableSource) {
      return { ok: false, error: "Audio action is not ready for the current shared source." };
    }
    setToolBusy(capability);
    setToolPhase("verifying");
    setToolError("");
    try {
      const operationId = crypto.randomUUID();
      const current = await refreshSharedSession();
      let artifactId = current.sourceAvailability === "staged" ? current.stagedSourceArtifactId || undefined : undefined;
      let finalSession = current;

      if (sourceFile) {
        const loadedHash = await sha256File(sourceFile);
        if (current.source?.sha256 !== loadedHash || current.sourceAvailability === "none") {
          throw new Error("Shared source changed. Tool was not run.");
        }
        if (!artifactId) {
          setToolPhase("staging");
          const stageForm = new FormData();
          stageForm.set("file", sourceFile);
          stageForm.set("sourceHash", loadedHash);
          const stageResponse = await fetch("/api/audio/artifacts/stage", {
            method: "POST",
            headers: { "x-brickhouse-operation-id": operationId },
            body: stageForm,
          });
          if (!stageResponse.ok) throw new Error("Could not stage the selected audio privately.");
          const staged = await stageResponse.json();
          artifactId = staged.artifact?.artifact_id || staged.artifactId;
          if (!artifactId) throw new Error("The staged audio did not return an artifact ID.");
          if (staged.session) finalSession = hydrateSharedSession(staged.session as SharedAudioSession);
        }
      } else if (!artifactId || !current.source?.sha256) {
        throw new Error("Load the exact source file before running this action.");
      }

      setToolPhase("processing");
      const processResponse = await fetch("/api/audio/process", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-brickhouse-operation-id": operationId,
        },
        body: JSON.stringify({ artifactId, capability }),
      });
      if (!processResponse.ok) throw new Error("The selected BrickHouse tool could not complete.");
      const processed = await processResponse.json();
      finalSession = await resolveAudioProcessResult<SharedAudioSession>(processed, {
        pollAudioJob,
        hydrateSharedSession,
        refreshSharedSession,
        setRemoteArtifacts: (artifacts) => setRemoteArtifacts(artifacts as RemoteArtifact[]),
        setSelectedArtifactId,
      });
      return { ok: true, session: finalSession };
    } catch (toolFailure) {
      const message = toolFailure instanceof Error ? toolFailure.message : "Remote processing failed.";
      setToolError(message);
      return { ok: false, error: message };
    } finally {
      setToolPhase(null);
      setToolBusy(null);
    }
  }


  async function refreshAudiotoolRegions() {
    setVocalAnalysisError("");
    if (!VOCAL_ANALYSIS_AVAILABLE) { setVocalAnalysisError("Vocal analysis is unavailable in this release."); return; }
    const projectUuid = verifiedDestination?.projectUuid;
    if (!projectUuid) { setVocalAnalysisError("Verify an Audiotool destination first."); return; }
    try {
      const response = await fetch(`/api/audio/audiotool/regions?projectUuid=${encodeURIComponent(projectUuid)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Audiotool regions are unavailable right now.");
      const payload = await response.json();
      const regions = Array.isArray(payload.regions) ? payload.regions as AudiotoolRegion[] : [];
      setAudiotoolRegions(regions);
      setSelectedVocalRegionId((current) => regions.some((item) => item.regionId === current) ? current : "");
      if (!regions.length) setVocalAnalysisError("No analyzable audio regions were found in the verified Audiotool project.");
    } catch (failure) {
      setVocalAnalysisError(failure instanceof Error ? failure.message : "Audiotool regions are unavailable right now.");
    }
  }

  async function analyzeVocalRegion() {
    if (!VOCAL_ANALYSIS_AVAILABLE) { setVocalAnalysisError("Vocal analysis is unavailable in this release."); return; }
    const projectUuid = verifiedDestination?.projectUuid;
    if (!projectUuid) { setVocalAnalysisError("Verify an Audiotool destination first."); return; }
    if (!selectedVocalRegionId || vocalAnalysisBusy) return;
    setVocalAnalysisBusy(true);
    setVocalAnalysisError("");
    setVocalAnalysis(null);
    try {
      const response = await fetch("/api/audio/audiotool/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ projectUuid, regionId: selectedVocalRegionId }),
      });
      if (!response.ok) throw new Error("BrickHouse could not verify the vocal analysis.");
      const payload = await response.json();
      if (payload.analysis?.status !== "ANALYZED_REMOTE_VERIFIED") throw new Error("Vocal analysis did not return verified results.");
      setVocalAnalysis(payload.analysis as VocalAnalysisResult);
    } catch (failure) {
      setVocalAnalysisError(failure instanceof Error ? failure.message : "Vocal analysis failed.");
    } finally {
      setVocalAnalysisBusy(false);
    }
  }


  async function askAboutAudioWith(question: string): Promise<boolean> {
    if (!ASK_ABOUT_AUDIO_AVAILABLE) { setAudioAskError("Ask About Audio is unavailable in this release."); return false; }
    const trimmed = question.trim();
    if (!trimmed || !sharedSession || audioAskBusy) return false;
    setAudioAskBusy(true);
    setAudioAskError("");
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/conversation/ask", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: current.revision, question: trimmed, researchAudioApproved }),
      });
      const payload = await response.json();
      if (!response.ok || payload.result?.status !== "ANSWERED_SOURCE_VERIFIED" || !payload.result?.session) {
        throw new Error(payload.error || "BrickHouse could not answer against the current source.");
      }
      hydrateSharedSession(payload.result.session as SharedAudioSession);
      return true;
    } catch (failure) {
      setAudioAskError(failure instanceof Error ? failure.message : "Ask About Audio failed.");
      return false;
    } finally {
      setAudioAskBusy(false);
    }
  }

  async function askAboutAudio() {
    const done = await askAboutAudioWith(audioQuestion);
    if (done) setAudioQuestion("");
  }

  async function verifyAudiotoolDestination() {
    const projectUuid = destinationUuidInput.trim();
    if (!sharedSession || !projectUuid || deliveryPhase === "sending" || deliveryPhase === "verifying") return;
    setDeliveryError("");
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/audiotool/destination/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: current.revision, projectUuid }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.session) throw new Error(payload.error || "Project verification was not accepted.");
      const session = hydrateSharedSession(payload.session as SharedAudioSession);
      setDestinationDisplayName(typeof payload.verification?.displayName === "string" ? payload.verification.displayName : session.audiotoolDestination?.projectUuid || projectUuid);
    } catch (failure) {
      setDeliveryError(failure instanceof Error ? failure.message : "Project verification failed.");
    }
  }

  async function clearAudiotoolDestination() {
    if (!sharedSession) return;
    setDeliveryError("");
    try {
      const current = await refreshSharedSession();
      const response = await fetch("/api/audio/audiotool/destination/clear", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: current.revision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.session) throw new Error(payload.error || "Could not clear the verified destination.");
      hydrateSharedSession(payload.session as SharedAudioSession);
      setDestinationDisplayName(null);
      setDeliveryReview(false);
    } catch (failure) {
      setDeliveryError(failure instanceof Error ? failure.message : "Could not clear the verified destination.");
    }
  }

  async function prepareAudiotoolDeliveryReview(): Promise<AudioActionResult> {
    const hasBundle = Boolean(sharedSession?.producerLibrary?.activeBundle?.candidateIds.length);
    if ((!hasBundle && !sharedSession?.source) || !sharedSession?.audiotoolDestination || applyInFlight) {
      return { ok: false, error: hasBundle
        ? "A verified Audiotool destination is required before Bundle review."
        : "Current source, selected artifact, and verified destination are required before review." };
    }
    setDeliveryError("");
    try {
      const current = await refreshSharedSession();
      const currentBundle = current.producerLibrary?.activeBundle;
      if (!current.audiotoolDestination) throw new Error("A verified Audiotool destination is required before review.");

      if (currentBundle?.candidateIds.length) {
        if (pendingBundleReviewMatchesCurrent(current) && current.pendingBundleDeliveryReview) {
          setDeliveryReview(true);
          return { ok: true, session: current };
        }
        const operationId = crypto.randomUUID();
        const response = await fetch("/api/audio/audiotool/bundle/review", {
          method: "POST",
          headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
          body: JSON.stringify({ expectedRevision: current.revision, operationId }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.session) throw new Error(payload.error || "Bundle review could not be prepared.");
        const session = hydrateSharedSession(payload.session as SharedAudioSession);
        setDeliveryReview(true);
        return { ok: true, session };
      }

      if (!current.source) throw new Error("Current source, selected artifact, and verified destination are required before review.");
      if (pendingReviewMatchesCurrent(current) && current.pendingDeliveryReview) {
        setDeliveryReview(true);
        return { ok: true, session: current };
      }
      const operationId = crypto.randomUUID();
      const response = await fetch("/api/audio/audiotool/review", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({ expectedRevision: current.revision, operationId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.session) throw new Error(payload.error || "Delivery review could not be prepared.");
      const session = hydrateSharedSession(payload.session as SharedAudioSession);
      setDeliveryReview(true);
      return { ok: true, session };
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Delivery review could not be prepared.";
      setDeliveryError(message);
      return { ok: false, error: message };
    }
  }

  async function confirmAudiotoolDelivery() {
    if (deliveryPhase === "sending" || deliveryPhase === "verifying") return;
    setDeliveryError("");
    setDeliveryPhase("sending");
    const verifyingTimer = window.setTimeout(() => setDeliveryPhase("verifying"), 450);
    try {
      const current = await refreshSharedSession();
      const bundleOperationId = current.pendingBundleDeliveryReview?.operationId
        || current.bundleDeliveryLifecycle?.operationId
        || null;
      if (bundleOperationId) {
        const response = await fetch("/api/audio/audiotool/bundle/delivery/confirm", {
          method: "POST",
          headers: { "content-type": "application/json", "x-brickhouse-operation-id": bundleOperationId },
          body: JSON.stringify({ expectedRevision: current.revision, operationId: bundleOperationId, confirm: true }),
        });
        const payload = await response.json().catch(() => ({}));
        const session = payload.session
          ? hydrateSharedSession(payload.session as SharedAudioSession)
          : await refreshSharedSession();
        const bundleLife = session.bundleDeliveryLifecycle;
        if (bundleLife?.status === "OUTCOME_UNKNOWN") {
          setDeliveryPhase("idle");
          setDeliveryError("");
          return;
        }
        if (bundleLife && ["VERIFIED", "PARTIAL", "FAILED_SAFE"].includes(bundleLife.status)) {
          setDeliveryReview(false);
          setDeliveryPhase("idle");
          return;
        }
        if (bundleLife?.status === "APPLY_IN_FLIGHT") {
          setDeliveryPhase("idle");
          return;
        }
        if (response.status === 409) {
          setDeliveryPhase("idle");
          setDeliveryError(payload.error || "Bundle send stopped safely. Reconcile or refresh the review before continuing.");
          return;
        }
        throw new Error(payload.error || "Bundle delivery was not verified. Nothing uncertain is marked sent.");
      }

      const operationId = current.pendingDeliveryReview?.operationId
        || current.deliveryLifecycle?.operationId
        || null;
      if (!operationId) throw new Error("Prepare review before confirming send.");
      const response = await fetch("/api/audio/audiotool/delivery/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({ expectedRevision: current.revision, operationId, confirm: true }),
      });
      const payload = await response.json().catch(() => ({}));
      const session = payload.session
        ? hydrateSharedSession(payload.session as SharedAudioSession)
        : await refreshSharedSession();
      const life = session.deliveryLifecycle;
      if (life?.status === "OUTCOME_UNKNOWN") {
        setDeliveryPhase("idle");
        setDeliveryError("");
        return;
      }
      if (life?.status === "VERIFIED" && life.receipt && lifecycleMatchesCurrent(session)) {
        setDeliveryReview(false);
        setDeliveryPhase("idle");
        return;
      }
      if (life?.status === "APPLY_IN_FLIGHT") {
        setDeliveryPhase("idle");
        return;
      }
      if (response.status === 409) {
        setDeliveryPhase("idle");
        setDeliveryError(payload.error || "Send stopped safely. Reconcile or refresh the review before continuing.");
        return;
      }
      throw new Error(payload.error || "Audiotool delivery was not verified. Nothing is marked sent.");
    } catch (failure) {
      await refreshSharedSession().catch(() => null);
      setDeliveryPhase("idle");
      setDeliveryError(failure instanceof Error ? failure.message : "Audiotool delivery was not verified.");
    } finally {
      window.clearTimeout(verifyingTimer);
    }
  }

  async function moveBundleMemberByBars(memberOperationId: string, bars: number) {
    if (regionShapeBusy) return;
    setRegionShapeBusy(memberOperationId);
    setDeliveryError("");
    try {
      const current = await refreshSharedSession();
      const lifecycle = current.bundleDeliveryLifecycle;
      if (!lifecycle || lifecycle.status === "APPLY_IN_FLIGHT" || lifecycle.status === "OUTCOME_UNKNOWN") {
        throw new Error("Bundle delivery must be settled before moving a landed region.");
      }
      const member = lifecycle.members.find((item) => item.operationId === memberOperationId);
      if (!member || member.status !== "VERIFIED" || !member.receipt) {
        throw new Error("Choose a verified landed Bundle member before moving it.");
      }
      const pending = member.pendingShape;
      if (pending && pending.bars !== bars) {
        throw new Error(`This region already has a pending ${pending.bars > 0 ? "+" : ""}${pending.bars}-bar move. Reconcile that exact move first.`);
      }
      const operationId = pending?.operationId || crypto.randomUUID();
      const response = await fetch("/api/audio/audiotool/bundle/member/move", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": operationId },
        body: JSON.stringify({
          expectedRevision: current.revision,
          lifecycleOperationId: lifecycle.operationId,
          memberOperationId,
          operationId,
          bars,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.session || !payload.receipt) {
        throw new Error(payload.error || "Audiotool region move could not be verified.");
      }
      const session = hydrateSharedSession(payload.session as SharedAudioSession);
      const label = libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name;
      const direction = bars > 0 ? `+${bars}` : String(bars);
      setAnnounce(`Moved ${label} ${direction} ${Math.abs(bars) === 1 ? "bar" : "bars"} in Audiotool and verified the exact region.`);
      return session;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Audiotool region move could not be verified.";
      setDeliveryError(message);
      await refreshSharedSession().catch(() => null);
      return null;
    } finally {
      setRegionShapeBusy(null);
    }
  }

  async function undoAudiotoolDelivery() {
    const undoable = sharedSession?.deliveryLifecycle?.receipt;
    if (!undoable?.undoAvailable || deliveryPhase === "undoing" || deliveryPhase === "verifying_undo") return;
    setDeliveryError("");
    setDeliveryPhase("undoing");
    const verifyingTimer = window.setTimeout(() => setDeliveryPhase("verifying_undo"), 450);
    try {
      const current = await refreshSharedSession();
      const receipt = current.deliveryLifecycle?.receipt;
      if (!receipt?.undoAvailable) throw new Error("The current Audiotool delivery is no longer available to undo.");
      const response = await fetch("/api/audio/audiotool/delivery/undo", {
        method: "POST",
        headers: { "content-type": "application/json", "x-brickhouse-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: current.revision, receiptId: receipt.receiptId, confirm: true }),
      });
      const payload = await response.json().catch(() => ({}));
      const verifiedSession = payload.session
        ? hydrateSharedSession(payload.session as SharedAudioSession)
        : await refreshSharedSession();
      const life = verifiedSession.deliveryLifecycle;
      if (life?.status === "UNDO_OUTCOME_UNKNOWN") {
        setDeliveryPhase("idle");
        setDeliveryError("");
        return;
      }
      if (life?.status === "ROLLED_BACK" && life.receipt) {
        setDeliveryReview(false);
        setDeliveryPhase("idle");
        return;
      }
      if (response.status === 409) {
        setDeliveryPhase("idle");
        return;
      }
      throw new Error(payload.error || "Audiotool undo was not verified.");
    } catch (failure) {
      await refreshSharedSession().catch(() => null);
      setDeliveryPhase("idle");
      setDeliveryError(failure instanceof Error ? failure.message : "Audiotool undo was not verified.");
    } finally {
      window.clearTimeout(verifyingTimer);
    }
  }

  useEffect(() => {
    webMcpActionsRef.current = {
      async getState() {
        const session = await refreshSharedSession();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { ok: true, session: summarizeSession(session), artifacts: summarizeArtifacts(session) };
      },
      async listTools() {
        return {
          ok: true,
          tools: tools.map((tool) => ({ id: tool.id, label: tool.label, status: tool.status })),
        };
      },
      async runTool(capability) {
        const result = await runAudioTool(capability);
        if (!result.ok) return result;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          ok: true,
          capability,
          session: summarizeSession(result.session),
          artifacts: summarizeArtifacts(result.session),
        };
      },
      async listArtifacts() {
        const session = await refreshSharedSession();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { ok: true, selectedArtifactId: session.selectedArtifactId, artifacts: summarizeArtifacts(session) };
      },
      async selectArtifact(artifactId) {
        const result = await selectSharedArtifact(artifactId);
        if (!result.ok) return result;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          ok: true,
          selectedArtifactId: result.session.selectedArtifactId,
          artifacts: summarizeArtifacts(result.session),
        };
      },
      async getDeliveryStatus() {
        const session = await refreshSharedSession();
        const freshProducerLoop = await refreshProducerLoop();
        const summary = summarizeSession(session);
        return {
          ok: true,
          destination: session.audiotoolDestination ? { projectUuid: session.audiotoolDestination.projectUuid, verifiedAt: session.audiotoolDestination.verifiedAt } : null,
          selectedArtifactId: session.selectedArtifactId,
          selectedArtifactLabel: selectedArtifactLabel(session),
          pendingDeliveryReview: summary.pendingDeliveryReview,
          deliveryLifecycle: summary.deliveryLifecycle,
          pendingBundleDeliveryReview: summary.pendingBundleDeliveryReview,
          bundleDeliveryLifecycle: summary.bundleDeliveryLifecycle,
          producerLoop: freshProducerLoop,
          phase: deliveryPhase,
          reviewOpen: Boolean(session.pendingDeliveryReview || session.pendingBundleDeliveryReview),
          requiresHumanConfirmation: true,
        };
      },
      async startDeliveryReview() {
        if (deliveryPhase === "sending" || deliveryPhase === "verifying") {
          return { ok: false, error: "Audiotool delivery is already in progress." };
        }
        const result = await prepareAudiotoolDeliveryReview();
        if (!result.ok) return result;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const pending = result.session.pendingDeliveryReview;
        const pendingBundle = result.session.pendingBundleDeliveryReview;
        return {
          ok: true,
          pendingDeliveryReview: pending || null,
          pendingBundleDeliveryReview: pendingBundle || null,
          bundleMemberCount: pendingBundle?.members.length || 0,
          selectedArtifactId: result.session.selectedArtifactId,
          destination: result.session.audiotoolDestination ? { projectUuid: result.session.audiotoolDestination.projectUuid } : null,
          reviewOpen: true,
          requiresHumanConfirmation: true,
          nextAction: "Confirm send in the Workbench UI. WebMCP may prepare/read the review but cannot confirm, send, or undo.",
        };
      },
    };
  });

  useEffect(() => {
    const modelContext = typeof document === "undefined"
      ? undefined
      : (document as Document & { modelContext?: WebMcpContext }).modelContext;
    if (!modelContext?.registerTool) return;

    const lifecycle = new AbortController();
    const actions = () => webMcpActionsRef.current;
    const unavailable = () => ({ ok: false, error: "Audio Workbench WebMCP actions are not ready yet." });

    const registrations = [
      {
        name: "get_audio_workbench_state",
        title: "Get Audio Workbench state",
        description: "Read the current shared Audio Workbench source, revision, selection, artifacts, pending request, and verified delivery receipt.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async execute() { return actions() ? actions()!.getState() : unavailable(); },
      },
      {
        name: "list_audio_tools",
        title: "List audio tools",
        description: "List producer-facing BrickHouse audio actions and whether each is currently ready.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        async execute() { return actions() ? actions()!.listTools() : unavailable(); },
      },
      {
        name: "run_audio_tool",
        title: "Run audio tool",
        description: "Run Split Stems or Analyze Deeper through the same source verification, private staging, processing, job polling, and shared-session path used by the Workbench UI.",
        inputSchema: {
          type: "object",
          properties: { capability: { type: "string", enum: ["split-stems", "analyze-deeper"] } },
          required: ["capability"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input: unknown) {
          const capability = input && typeof input === "object" ? (input as { capability?: unknown }).capability : undefined;
          if (capability !== "split-stems" && capability !== "analyze-deeper") return { ok: false, error: "Unsupported audio capability." };
          return actions() ? actions()!.runTool(capability) : unavailable();
        },
      },
      {
        name: "list_audio_artifacts",
        title: "List audio artifacts",
        description: "Read the Original and derived Audio Workbench artifacts plus the currently selected output.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async execute() { return actions() ? actions()!.listArtifacts() : unavailable(); },
      },
      {
        name: "select_audio_artifact",
        title: "Select audio artifact",
        description: "Select an existing Original or derived artifact in the authoritative shared Workbench session.",
        inputSchema: {
          type: "object",
          properties: { artifactId: { type: "string", minLength: 1 } },
          required: ["artifactId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input: unknown) {
          const artifactId = input && typeof input === "object" ? (input as { artifactId?: unknown }).artifactId : undefined;
          if (typeof artifactId !== "string" || !artifactId.trim()) return { ok: false, error: "artifactId is required." };
          return actions() ? actions()!.selectArtifact(artifactId) : unavailable();
        },
      },
      {
        name: "get_audiotool_delivery_status",
        title: "Get Audiotool delivery status",
        description: "Read the verified Audiotool destination, selected artifact, Producer Loop projection, and delivery lifecycle without writing to Audiotool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async execute() { return actions() ? actions()!.getDeliveryStatus() : unavailable(); },
      },
      {
        name: "start_audiotool_delivery_review",
        title: "Review Audiotool delivery",
        description: "Prepare the same server delivery review as the Workbench UI for the current selected artifact and verified destination. This does not send audio; a human must confirm the Audiotool write in the UI.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute() { return actions() ? actions()!.startDeliveryReview() : unavailable(); },
      },
    ];

    for (const tool of registrations) {
      try {
        void Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
      } catch {
        // WebMCP is an optional progressive enhancement; normal Workbench UI stays usable.
      }
    }

    return () => lifecycle.abort();
  }, []);

  const selectedPreviewUrl = selectedArtifactId !== "original"
    ? `/api/audio/artifacts/${encodeURIComponent(selectedArtifactId)}/preview`
    : null;
  const sourcePlayUrl = sourceObjectUrl || selectedPreviewUrl;
  const hasMeaningfulSelection = bundleCandidateIds.length > 0
    || Boolean(libraryState.chosenCandidateId)
    || selectedArtifactId !== "original"
    || stemArtifacts.length > 0;
  const hasDerivedResults = remoteArtifacts.length > 0 || selectedArtifactId !== "original";
  const showContextTools = hasMeaningfulSelection || Boolean(activeOperation);
  const showDeliverySurface = hasMeaningfulSelection
    || Boolean(verifiedDestination || pendingReview || pendingBundleReview || bundleLifecycle || previousPlacement || verifiedDelivery || rolledBackDelivery || outcomeUnknown || bundleOutcomeUnknown || undoOutcomeUnknown || applyInFlight);
  const activeCandidate = libraryCandidates.find((entry) => entry.candidateId === libraryState.activeCandidateId) || null;
  const auditionCandidates = (() => {
    const ordered: ProducerCandidate[] = [];
    const seen = new Set<string>();
    const selectedCandidateId = libraryState.chosenCandidateId;
    const priorityIds = [libraryState.activeCandidateId, ...libraryState.heldCandidateIds]
      .filter((candidateId): candidateId is string => Boolean(candidateId && candidateId !== selectedCandidateId));
    for (const candidateId of priorityIds) {
      const candidate = libraryCandidates.find((entry) => entry.candidateId === candidateId);
      if (candidate && !seen.has(candidate.candidateId)) {
        seen.add(candidate.candidateId);
        ordered.push(candidate);
      }
    }
    for (const candidate of libraryCandidates) {
      if (candidate.candidateId === selectedCandidateId || seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      ordered.push(candidate);
      if (ordered.length >= 4) break;
    }
    if (ordered.length < 4 && selectedCandidateId) {
      const selectedCandidate = libraryCandidates.find((entry) => entry.candidateId === selectedCandidateId);
      if (selectedCandidate && !seen.has(selectedCandidate.candidateId)) ordered.push(selectedCandidate);
    }
    return ordered.slice(0, 4);
  })();
  const deckStatusText = !sharedSession
    ? "Connecting."
    : libraryCandidates.length === 0
      ? "Finding choices."
      : `${libraryCandidates.length} choices \u00B7 ${libraryState.heldCandidateIds.length} held`;
  const sourceMetaLine = analysis
    ? `${analysis.duration.toFixed(2)} s \u00B7 ${analysis.sampleRate.toLocaleString()} Hz \u00B7 ${analysis.channels} ch`
    : "";
  const sourceStateText = !hasSource
    ? "Empty"
    : busy
      ? "Loading"
      : sharedSession?.sourceAvailability === "staged"
        ? "Private to you — nothing sent yet"
        : hasSharedSource
          ? "Ready \u00B7 shared source"
          : "Ready \u00B7 local only";

  function transcribeWithAsk() {
    setAudioQuestion("Transcribe this audio verbatim.");
    setAnnounce("Transcribe is ready in Ask About Audio. Review it and press Ask to run.");
    requestAnimationFrame(() => document.getElementById("ask-input")?.focus());
  }

  function transformWithIntent() {
    setIntent((current) => (current.trim() ? current : "Transform this into "));
    setAnnounce("Describe the transform, then press Go. Nothing generates silently.");
    requestAnimationFrame(() => document.getElementById("intent-input")?.focus());
  }

  async function routeIntent() {
    const text = intent.trim();
    if (!text || intentBusy || libraryBusy || toolBusy || audioAskBusy) return;
    if (!sharedSession || !hasSource) {
      setAnnounce("Add sound first, then steer it here.");
      return;
    }
    const lower = text.toLowerCase();
    const target = libraryState.activeCandidateId || libraryCandidates[0]?.candidateId || null;
    const wantsOther = (words: string[]) => words.some((word) => lower.includes(word));
    setIntentBusy(true);
    try {
      if ((lower === "next" || lower === "skip" || lower === "another" || lower === "next one") && !wantsOther(["split", "stem", "analy", "transcri", "transform", "use", "choose", "hold"])) {
        await runLibraryAction("next");
        setIntent("");
        return;
      }
      if ((lower === "more" || lower === "more please" || lower === "show more") && !wantsOther(["split", "analy"])) {
        await runLibraryAction("more");
        setIntent("");
        return;
      }
      if (lower.includes("unhold") || lower.includes("release this")) {
        const heldId = libraryState.heldCandidateIds[0] || null;
        if (!heldId) {
          setAnnounce("Nothing is held.");
          return;
        }
        await runLibraryAction("hold", heldId);
        setIntent("");
        return;
      }
      if (lower.includes("hold")) {
        if (!target) {
          setAnnounce("Nothing to hold yet.");
          return;
        }
        await runLibraryAction("hold", target);
        setIntent("");
        return;
      }
      if (lower.includes("use this") || lower.includes("use it") || lower.includes("choose") || lower.includes("pick this") || lower === "this one") {
        const staged = libraryState.activeCandidateId || libraryState.heldCandidateIds[0] || null;
        if (!staged) {
          setAnnounce("Play something first, then say use this.");
          return;
        }
        await chooseLibraryCandidate(staged);
        setIntent("");
        return;
      }
      if (lower.includes("split") || lower.includes("stem")) {
        setAnnounce("Splitting stems from the current source.");
        await runAudioTool("split-stems");
        setIntent("");
        return;
      }
      if (lower.includes("analy") || lower.includes("deeper") || lower.includes("understand")) {
        setAnnounce("Analyzing deeper.");
        await runAudioTool("analyze-deeper");
        setIntent("");
        return;
      }
      if (lower.includes("transcri") || lower.includes("lyric")) {
        setAnnounce("Transcribing the current audio.");
        const transcribed = await askAboutAudioWith(`Transcribe this audio verbatim. Note: ${text}`);
        if (transcribed) setIntent("");
        return;
      }
      if (lower.includes("transform") || lower.includes("remix") || lower.includes("convert")) {
        setAnnounce("Checking transform options against the current tools.");
        const transformed = await askAboutAudioWith(`Transform idea for the current audio: ${text}. Using only the existing Workbench actions, what are my options? Do not generate anything yet.`);
        if (transformed) setIntent("");
        return;
      }
      setAnnounce("Asking BrickHouse about the current audio.");
      const answered = await askAboutAudioWith(text);
      if (answered) setIntent("");
    } finally {
      setIntentBusy(false);
    }
  }

  const chosenCandidate = libraryState.chosenCandidateId
    ? libraryCandidates.find((entry) => entry.candidateId === libraryState.chosenCandidateId) || null
    : null;

  return (
    <main className={hasMeaningfulSelection ? "shell shell-instrument shell-committed" : "shell shell-instrument"}>
      <div className="sr-only" aria-live="polite" role="status" id="announce-live">{announce}</div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">BH</span>
          <span className="brand-name">BrickHouse <em>Audio Workbench</em></span>
        </div>
        <p className={`session-pill${sessionError ? " is-error" : ""}`} role="status" aria-live="polite"><span className="pulse" aria-hidden="true" /> {sessionLabel}</p>
      </header>

      {sessionError && <p className="error sessionError" role="alert">{sessionError}</p>}

      <section className="panel sourcePanel instrumentStrip" id="sound" aria-labelledby="sound-heading">
        <div className="instrumentHeader"><span className="kicker">MY SOUND</span><strong id="sound-heading">{hasSource ? currentSourceDisplayName : "Drop your sound in"}</strong>{hasSource && <small>{sourceStateText}</small>}</div>
        <div className="instrumentBody">
        {!hasSource ? (
          <div className="source-empty">
            <h3>Drop your sound in to start.</h3>
            <p>One file. Then tell BrickHouse what to make of it.</p>
            <label className="dropzone" onDragOver={handleAudioDragOver} onDrop={handleAudioDrop}>
              <input type="file" accept="audio/*,.wav,.aif,.aiff" aria-label="Choose an audio file" onChange={pickAudio} />
              <span className="dropIcon" aria-hidden="true">+</span>
              <strong>{busy ? "Preparing…" : "Drop audio here or choose a file"}</strong>
              <small>Local-first. Remote bytes move only after an explicit approved action.</small>
            </label>
          </div>
        ) : (
          <div className="source-row">
            {sourcePlayUrl ? (
              <CustomPlayer
                layout="source"
                src={sourcePlayUrl}
                audioLabel={currentSourceName === "No shared source yet" ? "current source" : currentSourceName}
                peaks={analysis?.waveform ?? null}
                disabledReason={null}
              />
            ) : (
              <div className="source-quiet" role="note">
                <span className="source-quietHint">Drop original file to A/B preview</span>
              </div>
            )}
            <div className="source-id">
              {sourceMetaLine && <span className="source-meta">{sourceMetaLine}</span>}
              <details className="sourceAlternate">
                <summary title={sourceFile ? `Current local file: ${displaySourceName(sourceFile.name)}` : undefined}><span>Replace source</span><small className="sr-only">Use a local file instead</small></summary>
                <label className="dropzone compactDropzone" onDragOver={handleAudioDragOver} onDrop={handleAudioDrop}>
                  <input type="file" accept="audio/*,.wav,.aif,.aiff" aria-label="Choose an audio file" onChange={pickAudio} />
                  <span className="dropIcon" aria-hidden="true">+</span>
                  <strong>{busy ? "Preparing…" : sourceFile ? "Replace local source" : "Drop audio here or choose a file"}</strong>
                  <small>Local-first. Remote bytes move only after an explicit approved action.</small>
                </label>
              </details>
            </div>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {sourceFile && !analysis && <p className="deferred-note"><strong>Signal analysis deferred.</strong><span> Source identity is ready; full analysis stays optional.</span></p>}
        </div>
      </section>

      <section className="panel intentPanel instrumentStrip" id="make" aria-label="What are we making?">
        <div className="instrumentHeader"><span className="kicker">WHAT ARE WE MAKING?</span>{intent.trim() && <small>{intent.trim()}</small>}</div>
        <div className="instrumentBody">
        <IntentComposer
          value={intent}
          onChange={setIntent}
          onSubmit={() => void routeIntent()}
          disabled={!hasSource}
          needSource={!hasSource}
          busy={Boolean(intentBusy || libraryBusy || toolBusy || audioAskBusy)}
        />
        </div>
      </section>

      {chosenCandidate && (
        <aside className="commitBar selectedRail" role="status" aria-label="Selected sound commit row">
          <div className="commitInfo">
            <span className="kicker">SELECTED</span>
            <strong>{chosenCandidate.title} · {chosenCandidate.bpm} BPM · {chosenCandidate.key}</strong>
            <small className="commitState">Private to you — nothing sent yet</small>
          </div>
          <div className="commitActions">
            {verifiedDestination ? (
              <button
                type="button"
                className="commitReview"
                disabled={libraryBusy || applyInFlight || deliveryPhase === "sending" || deliveryPhase === "verifying"}
                onClick={() => void prepareAudiotoolDeliveryReview()}
              >
                Review & Send →
              </button>
            ) : (
              <a className="commitLink" href="#delivery">Connect Audiotool to send →</a>
            )}
          </div>
        </aside>
      )}

      <section className="panel libraryPanel auditionWorkspace" id="audition" aria-labelledby="audition-heading">
        <div className="auditionToolbar">
          <div className="auditionTitle"><span className="kicker">PRODUCER LIBRARY</span><strong id="audition-heading">Choose by ear</strong><small>{deckStatusText}</small></div>
          <div className="deck-actions">
            <button type="button" className="btn btn-primary deck-next" disabled={!sharedSession || libraryBusy || libraryCandidates.length === 0} onClick={() => void runLibraryAction("next")}>Next</button>
            <button type="button" className="deck-more" disabled={!sharedSession || libraryBusy || libraryState.visiblePages >= 20} onClick={() => void runLibraryAction("more")}>More choices</button>
          </div>
        </div>
        <form
          className="nativeSearch"
          aria-label="Search Audiotool samples"
          onSubmit={(event) => {
            event.preventDefault();
            if (!nativeDraft.q.trim()) return;
            setLibraryCandidates([]);
            setNativeSearch({ ...nativeDraft });
          }}
        >
          <input
            aria-label="Describe the sound"
            placeholder="Search Audiotool samples — e.g. dusty percussion"
            value={nativeDraft.q}
            onChange={(event) => setNativeDraft({ ...nativeDraft, q: event.target.value })}
          />
          <select aria-label="Sample type" value={nativeDraft.kind} onChange={(event) => setNativeDraft({ ...nativeDraft, kind: event.target.value as NativeSearch["kind"] })}>
            <option value="loop">Loops</option>
            <option value="one-shot">One-shots</option>
            <option value="">Any</option>
          </select>
          <input aria-label="Around BPM" inputMode="numeric" placeholder="BPM" value={nativeDraft.bpm} onChange={(event) => setNativeDraft({ ...nativeDraft, bpm: event.target.value.replace(/[^0-9.]/g, "") })} />
          <button type="submit" disabled={!nativeDraft.q.trim()}>Search Audiotool</button>
          {nativeSearch && <button type="button" onClick={() => { setLibraryCandidates([]); setNativeSearch(null); }}>BrickHouse Library</button>}
        </form>
        {nativeSearch && <p className="nativeSearchNote" role="status">Audiotool catalog · “{nativeSearch.q}”{nativeSearch.kind ? ` · ${nativeSearch.kind}s` : ""}{nativeSearch.bpm ? ` · ~${nativeSearch.bpm} BPM` : ""} — previews stream from Audiotool; nothing is added to your project until you Send.</p>}
        {libraryError && <p className="error" role="alert">{libraryError}</p>}
        {!sharedSession ? <p className="empty">Connect the shared Workbench session to browse verified candidates.</p> : libraryCandidates.length === 0 ? <p className="empty">{nativeSearch ? "Searching Audiotool’s sample catalog…" : "Producer Library is loading verified candidates."}</p> : (
          <AuditionDeck
            candidates={auditionCandidates}
            activeCandidateId={libraryState.activeCandidateId}
            heldCandidateIds={libraryState.heldCandidateIds}
            bundleCandidateIds={bundleCandidateIds}
            chosenCandidateId={libraryState.chosenCandidateId}
            playbackBlockedCandidateId={libraryPlaybackBlockedCandidateId}
            busy={libraryBusy}
            previewUrlFor={(candidate) => (candidate as ProducerCandidate).previewUrl || `/api/audio/library/candidates/${candidate.providerId}/preview`}
            onPlay={(candidateId) => void runLibraryAction("play", candidateId)}
            onHold={(candidateId) => void runLibraryAction("hold", candidateId)}
            onBundleToggle={(candidateId, bundled) => void runBundleAction(bundled ? "remove" : "add", candidateId)}
            onUse={(candidateId) => void chooseLibraryCandidate(candidateId)}
            registerAudio={(id, el) => {
              if (el) libraryAudioRefs.current.set(id, el);
              else libraryAudioRefs.current.delete(id);
            }}
          />
        )}
        {bundleCandidateIds.length > 0 && (
          <div className="bundleRail" aria-label="Current Bundle">
            <div className="bundleRailHead">
              <span className="kicker">BUNDLE</span>
              <strong>{bundleCandidateIds.length} {bundleCandidateIds.length === 1 ? "sound" : "sounds"} ready to review together</strong>
              <button type="button" className="bundleClear" disabled={libraryBusy} onClick={() => void runBundleAction("clear")}>Clear</button>
            </div>
            <ol className="bundleList">
              {bundleCandidates.map(({ candidateId, candidate }, index) => (
                <li key={candidateId}>
                  <span className="bundleOrder">{index + 1}</span>
                  <span className="bundleName">{candidate?.title || `Sound ${index + 1}`}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${candidate?.title || `sound ${index + 1}`} from Bundle`}
                    disabled={libraryBusy}
                    onClick={() => void runBundleAction("remove", candidateId)}
                  >×</button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {showContextTools && <details className="panel toolsPanel foldSection" id="tools" open={Boolean(activeOperation)}>
        <summary className="foldSummary"><span className="foldCopy"><span className="kicker">TOOLS</span><strong id="tools-heading">Shape it</strong><small>Split, transcribe, transform, analyze</small></span><span className="foldToggle" aria-hidden="true" /></summary>
        <div className="foldBody">
        {activeOperation && <div className="operationStatus" role="status" aria-live="polite"><span className="kicker">{activeOperation.actor.toUpperCase()} ACTIVITY</span><strong>{activeOperation.label}</strong><small>{activeOperation.phase} · exact source and revision checks stay active</small></div>}
        <div className="tool-tray" role="group" aria-label="Audio tools">
          {tools.map((tool) => {
            const available = tool.status === "ready";
            const running = toolBusy === tool.id;
            const status = running
              ? toolPhase === "verifying" ? "Verifying…" : toolPhase === "staging" ? "Staging…" : "Working…"
              : available && hasRunnableSource ? "Ready"
                : available ? "Source needed"
                  : tool.status === "checking" ? "Checking…" : "Unavailable";
            return <button type="button" className="chip-tool" key={tool.id} disabled={!sharedSession || !available || !hasRunnableSource || Boolean(toolBusy)} onClick={() => runAudioTool(tool.id)}><span>{tool.label}</span><small>{status}</small></button>;
          })}
          <button type="button" className="chip-tool" disabled={!hasSource || audioAskBusy} onClick={transcribeWithAsk}><span>Transcribe</span><small>Words, via Ask</small></button>
          <button type="button" className="chip-tool" disabled={!hasSource || audioAskBusy} onClick={transformWithIntent}><span>Transform</span><small>Describe it first</small></button>
        </div>
        {toolError && <p className="error" role="alert">{toolError}</p>}
        </div>
      </details>}

      {hasDerivedResults && <details className="panel resultsPanel foldSection" id="versions">
        <summary className="foldSummary"><span className="foldCopy"><span className="kicker">RESULTS</span><strong id="versions-heading">Your versions</strong><small>{remoteArtifacts.length} derived {remoteArtifacts.length === 1 ? "version" : "versions"}</small></span><span className="foldToggle" aria-hidden="true" /></summary>
        <div className="foldBody">
        {!hasSource ? <p className="empty">Versions appear once a source is in.</p> : <>
          {stemArtifacts.length > 0 && <div className="previewGrid">{stemArtifacts.map((artifact) => {
            const artifactId = artifact.artifact_id || artifact.name;
            const label = artifactLabel(artifact.name);
            return <article className="previewCard" key={`preview-${artifactId}`}>
              <div><p className="kicker">{label.toUpperCase()}</p><strong>{artifact.name}</strong><small>{artifact.bytes ? `${artifact.bytes.toLocaleString()} bytes` : "Private derived artifact"} · preview does not send</small></div>
              <CustomPlayer layout="mini" src={`/api/audio/artifacts/${encodeURIComponent(artifactId)}/preview`} audioLabel={`Preview ${label}`} peaks={null} />
            </article>;
          })}</div>}
          <div className="artifactPicker resultShelf">
            <div className="artifactChoices" role="group" aria-label="Choose the version that moves forward">
              <button type="button" disabled={!sharedSession} aria-pressed={selectedArtifactId === "original"} className={selectedArtifactId === "original" ? "selected" : ""} onClick={() => void selectSharedArtifact("original")}>Original</button>
              {remoteArtifacts.map((artifact) => { const artifactId = artifact.artifact_id || artifact.name; return <button type="button" key={artifactId} disabled={!sharedSession} aria-pressed={selectedArtifactId === artifactId} className={selectedArtifactId === artifactId ? "selected" : ""} onClick={() => void selectSharedArtifact(artifactId)}>{artifactLabel(artifact.name)}</button>; })}
            </div>
            <p className="resultHint">Vocals · Instrumental · Analysis appear only when those artifacts actually exist.</p>
          </div>
        </>}
        </div>
      </details>}

      {showDeliverySurface && <details className="panel destinationPanel foldSection" open={Boolean(pendingReview || pendingBundleReview || bundleLifecycle || applyInFlight || outcomeUnknown || bundleOutcomeUnknown || undoOutcomeUnknown || deliveryPhase === "sending" || deliveryPhase === "verifying" || deliveryPhase === "undoing" || deliveryPhase === "verifying_undo")}>
        <summary className="foldSummary"><span className="foldCopy"><span className="kicker">AUDIOTOOL</span><strong>Delivery</strong><small>{bundleLifecycle?.status === "VERIFIED" ? "Bundle sent and verified" : bundleLifecycle?.status === "PARTIAL" ? "Bundle partially delivered" : bundleLifecycle?.status === "FAILED_SAFE" ? "Bundle stopped safely" : bundleOutcomeUnknown ? "Bundle outcome unknown" : pendingBundleReview ? "Bundle review ready" : verifiedDelivery ? "Sent and verified" : rolledBackDelivery ? "Rolled back" : pendingReview ? "Review ready" : verifiedDestination ? "Destination verified" : "Human approval only"}</small></span><span className="foldToggle" aria-hidden="true" /></summary>
        <div className="foldBody">
        <div className="panelTitle">
          <div><span className="kicker">AUDIOTOOL</span><h2 id="delivery" tabIndex={-1}>{bundleLifecycle?.status === "VERIFIED" ? "Bundle delivery verified." : bundleLifecycle?.status === "PARTIAL" ? "Bundle partially delivered." : bundleLifecycle?.status === "FAILED_SAFE" ? "Bundle stopped safely before uncertain writes." : bundleOutcomeUnknown ? "BUNDLE OUTCOME UNKNOWN — reconcile before any retry" : verifiedDelivery ? "Delivery verified." : rolledBackDelivery ? "Delivery undone." : outcomeUnknown || undoOutcomeUnknown ? "OUTCOME UNKNOWN — reconcile before retry" : "Approve before anything leaves Workbench."}</h2></div>
          <span className={bundleLifecycle?.status === "VERIFIED" || verifiedDelivery ? "safeBadge" : "mutedBadge"}>{bundleLifecycle?.status === "VERIFIED" ? "BUNDLE SENT · VERIFIED" : bundleLifecycle?.status === "PARTIAL" ? "BUNDLE PARTIAL" : bundleLifecycle?.status === "FAILED_SAFE" ? "BUNDLE FAILED SAFE" : bundleOutcomeUnknown ? "BUNDLE OUTCOME UNKNOWN" : verifiedDelivery ? "SENT AND VERIFIED" : rolledBackDelivery ? "ROLLED_BACK" : applyInFlight ? "APPLY IN FLIGHT" : outcomeUnknown || undoOutcomeUnknown ? "OUTCOME UNKNOWN" : pendingBundleReview || pendingReview ? "NOT SENT · NEEDS_USER" : "NOT SENT · HUMAN APPROVAL"}</span>
        </div>
        {!hasMeaningfulSelection && !verifiedDestination && !pendingReview && !previousPlacement && !verifiedDelivery && !rolledBackDelivery && !outcomeUnknown && !undoOutcomeUnknown && !applyInFlight ? (
          <p className="send-quiet">Nothing to send yet. <a href="#audition">Audition above</a> — delivery appears here once you use something.</p>
        ) : (<>
        <div className="destinationRow destinationVerify">
          <div>
            <strong>{verifiedDestination ? destinationLabel : "Choose an Audiotool project"}</strong>
            <small className="destinationUuidNote">{verifiedDestination ? "Connected and verified for this Workbench session." : "Paste a project UUID once; Workbench verifies the exact open Audiotool project before review."}</small>
            {!verifiedDestination && <label className="destinationUuidField">
              <span>Project UUID</span>
              <input aria-label="Audiotool project UUID" value={destinationUuidInput} onChange={(event) => setDestinationUuidInput(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </label>}
          </div>
          <div className="deliveryActions">
            {!verifiedDestination ? <button className="primaryAction" aria-label="Verify project" disabled={!sharedSession || !destinationUuidInput.trim()} onClick={() => void verifyAudiotoolDestination()}>Connect Audiotool</button> : <button className="secondaryAction" aria-label="Clear destination" onClick={() => void clearAudiotoolDestination()}>Change project</button>}
          </div>
        </div>
        {applyInFlight && <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>APPLY IN FLIGHT</strong><small>The authoritative operation is still in flight. Refresh or reconcile this exact operation; never create a replacement send.</small></div></div>}
        {outcomeUnknown && <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>OUTCOME UNKNOWN — reconcile before retry</strong><small>Remote apply outcome is not proven. Do not treat this as failed or not sent. Human reconcile only; never auto-retry.</small></div></div>}
        {undoOutcomeUnknown && <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>UNDO OUTCOME UNKNOWN — reconcile before retry</strong><small>Rollback is not proven. Do not claim undo completed.</small></div></div>}
        {bundleLifecycle || pendingBundleReview ? (
          deliveryPhase === "sending" || deliveryPhase === "verifying" ? (
            <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>{deliveryPhase === "sending" ? "Sending Bundle members…" : "Verifying each Audiotool placement…"}</strong><small>Each member gets its own operation identity, fresh readback, and receipt.</small></div></div>
          ) : bundleOutcomeUnknown && bundleLifecycle ? (
            <div className="deliveryReview"><div><span className="kicker">BUNDLE OUTCOME UNKNOWN</span><strong>Stop and reconcile the uncertain sound before any retry.</strong><ol className="bundleDeliveryMembers">{bundleLifecycle.members.map((member, index) => <li key={member.operationId}><span>{index + 1}. {libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name}</span><strong>{member.status === "VERIFIED" ? "Placed & verified" : member.status === "OUTCOME_UNKNOWN" ? "Needs reconciliation" : member.status === "FAILED_SAFE" ? "Stopped safely" : member.status === "APPLY_IN_FLIGHT" ? "Placing…" : "Waiting"}</strong>{member.receipt && <small>Verified in Audiotool</small>}</li>)}</ol><small>A missing receipt is not proof that Audiotool did nothing. Reconcile checks the exact placement before any further send.</small></div><div className="deliveryActions"><button className="primaryAction" onClick={() => void confirmAudiotoolDelivery()}>Reconcile</button></div></div>
          ) : bundleLifecycle?.status === "APPLY_IN_FLIGHT" ? (
            <div className="deliveryReview"><div><span className="kicker">BUNDLE APPLY IN FLIGHT</span><strong>{bundleVerifiedCount} verified · {bundleLifecycle.members.length - bundleVerifiedCount} remaining</strong><ol className="bundleDeliveryMembers">{bundleLifecycle.members.map((member, index) => <li key={member.operationId}><span>{index + 1}. {libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name}</span><strong>{member.status === "VERIFIED" ? "Placed & verified" : member.status === "OUTCOME_UNKNOWN" ? "Needs reconciliation" : member.status === "FAILED_SAFE" ? "Stopped safely" : member.status === "APPLY_IN_FLIGHT" ? "Placing…" : "Waiting"}</strong>{member.receipt && <small>Verified in Audiotool</small>}</li>)}</ol></div><div className="deliveryActions"><button className="secondaryAction" onClick={() => void confirmAudiotoolDelivery()}>Reconcile</button></div></div>
          ) : bundleLifecycle ? (
            <div className="deliveryReceipt" role="status" aria-live="polite"><div><span className="kicker">{bundleLifecycle.status === "VERIFIED" ? "SENT AND VERIFIED" : bundleLifecycle.status === "PARTIAL" ? "PARTIALLY DELIVERED" : "STOPPED SAFELY"}</span><strong>{bundleLifecycle.status === "VERIFIED" ? `${bundleVerifiedCount} sounds placed in ${destinationLabel}` : `${bundleVerifiedCount} verified · ${bundleFailedCount} stopped safely · ${bundleUnknownCount} unknown`}</strong><ol className="bundleDeliveryMembers">{bundleLifecycle.members.map(renderSettledBundleMember)}</ol><small>{bundleLifecycle.status === "VERIFIED" ? "Each sound is a separate verified Audiotool placement. Technical receipts stay in Advanced." : bundleLifecycle.status === "PARTIAL" ? "Verified placements stay put. Resolve the remaining member before changing the Bundle." : "Nothing uncertain is claimed sent. Prepare a fresh review when the destination is ready."}</small></div><div className="deliveryActions">{bundleLifecycle.status === "VERIFIED" && <span className="verifiedMark">✓ Verified in Audiotool</span>}{bundleLifecycle.status === "FAILED_SAFE" && <button className="primaryAction" disabled={!verifiedDestination} onClick={() => void prepareAudiotoolDeliveryReview()}>Review again</button>}</div></div>
          ) : pendingBundleReview ? (
            <div className="deliveryReview"><div><span className="kicker">{pendingBundleReviewCurrent ? "REVIEW BUNDLE" : "REVIEW EXPIRED SAFELY"}</span><strong>{pendingBundleReview.members.length} {pendingBundleReview.members.length === 1 ? "sound" : "sounds"} → {destinationLabel}</strong><ol className="bundleDeliveryMembers">{pendingBundleReview.members.map((member, index) => <li key={member.operationId}><span>{index + 1}. {libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name}</span><small>Private BrickHouse artifact · ready for separate placement</small></li>)}</ol><small>{pendingBundleReviewCurrent ? "One confirmation approves this exact order for separate placements into this verified Audiotool project." : "The session changed after review. Nothing was sent; refresh review before confirming."}</small></div><div className="deliveryActions"><button className="secondaryAction" onClick={() => setDeliveryReview(false)}>Cancel</button>{pendingBundleReviewCurrent ? <button className="primaryAction" onClick={() => void confirmAudiotoolDelivery()}>Confirm Bundle Send</button> : <button className="primaryAction" onClick={() => void prepareAudiotoolDeliveryReview()}>Refresh review</button>}</div></div>
          ) : null
        ) : deliveryPhase === "undoing" || deliveryPhase === "verifying_undo" ? (
          <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>{deliveryPhase === "undoing" ? "Undoing delivery…" : "Verifying Audiotool rollback…"}</strong><small>Undo uses the exact current revision and receiptId only.</small></div></div>
        ) : verifiedDelivery && verifiedDelivery.receipt ? (
          <div className="deliveryReceipt" role="status" aria-live="polite"><div><span className="kicker">SENT AND VERIFIED</span><strong>{selectedArtifactLabel(sharedSession!)} → {destinationLabel}</strong><small>Verified in Audiotool · {new Date(verifiedDelivery.receipt.observedAt).toLocaleString()}</small></div><div className="deliveryActions"><span className="verifiedMark">✓ Sent and verified</span>{verifiedDelivery.receipt.undoAvailable && <button className="secondaryAction" onClick={() => void undoAudiotoolDelivery()}>Undo Send</button>}</div></div>
        ) : deliveryPhase === "sending" || deliveryPhase === "verifying" ? (
          <div className="deliveryStatus" role="status" aria-live="polite"><span className="pulse"/><div><strong>{deliveryPhase === "sending" ? "Sending selected artifact…" : "Verifying remote placement…"}</strong><small>Success only after the session lifecycle is VERIFIED with an exact receipt.</small></div></div>
        ) : pendingReview || deliveryReview ? (
          <div className="deliveryReview"><div><span className="kicker">{stalePendingReview ? "REVIEW EXPIRED SAFELY" : "Review delivery"}</span><strong>{sharedSession ? selectedArtifactLabel(sharedSession) : "Selected artifact"} → {destinationLabel}</strong>{pendingReview && <ul><li>Selected version is frozen for this review</li><li>Private source verified</li><li>Current session revision checked</li></ul>}<small>{stalePendingReview ? "The session changed after review. Nothing was sent; refresh review before a new human confirmation." : "This is the write boundary. Previewing above does not send anything."}</small></div><div className="deliveryActions"><button className="secondaryAction" onClick={() => setDeliveryReview(false)}>Cancel</button>{stalePendingReview ? <button className="primaryAction" disabled={applyInFlight} onClick={() => void prepareAudiotoolDeliveryReview()}>Refresh review</button> : outcomeUnknown ? <button className="primaryAction" disabled={applyInFlight} onClick={() => void confirmAudiotoolDelivery()}>Reconcile</button> : <button className="primaryAction" disabled={!pendingReview || applyInFlight} onClick={() => void confirmAudiotoolDelivery()}>Confirm Send</button>}</div></div>
        ) : rolledBackDelivery && rolledBackDelivery.receipt ? (
          <div className="deliveryReview"><div><span className="kicker">ROLLED_BACK</span><strong>Verified rollback</strong><small>Receipt {rolledBackDelivery.receipt.receiptId} · {new Date(rolledBackDelivery.receipt.observedAt).toLocaleString()}. Source and artifacts remain available.</small></div><div className="deliveryActions"><button className="primaryAction" disabled={!verifiedDestination || !hasSource} onClick={() => void prepareAudiotoolDeliveryReview()}>Prepare review</button></div></div>
        ) : (
          <div className="destinationRow deliveryHappy"><div><strong>{verifiedDestination ? "Not sent" : "Destination not verified"}</strong><small>{bundleCandidateIds.length > 0 && verifiedDestination ? `${bundleCandidateIds.length} Bundle ${bundleCandidateIds.length === 1 ? "sound is" : "sounds are"} ready for one exact review before separate placement.` : hasSource && verifiedDestination ? "Your selected version is staged locally. Review the destination before sending." : "Build a Bundle or load a source, then verify a project before review."}</small>{previousPlacement && lifecycle?.receipt && <small className="receiptNote">An earlier receipt ({lifecycle.receipt.receiptId}) does not match the current selection — details live in <a href="#details">Activity &amp; recovery</a>.</small>}</div>{outcomeUnknown ? <button className="primaryAction" disabled={applyInFlight} onClick={() => void confirmAudiotoolDelivery()}>Reconcile</button> : undoOutcomeUnknown ? <button className="primaryAction" onClick={() => void undoAudiotoolDelivery()}>Reconcile</button> : <button className="primaryAction" disabled={(!hasSource && bundleCandidateIds.length === 0) || !verifiedDestination} onClick={() => void prepareAudiotoolDeliveryReview()}>Prepare review</button>}</div>
        )}
        </>)}
        {deliveryError && <p className="error" role="alert">{deliveryError}</p>}
        </div>
      </details>}

      <details className="advancedBlock" id="advanced">
        <summary className="advancedSummary">
          <span className="kicker advancedLabel">ADVANCED</span>
          <strong>Tools · activity · system details</strong>
          <span className="advancedToggle" aria-hidden="true" />
        </summary>
        <div className="advancedBody">
        <details className="flowDetails" id="details">
        <summary><span>Activity &amp; recovery</span><small>Revision, provenance, receipts, recovery</small></summary>
        {previousPlacement && lifecycle?.receipt && (
          <div className="deliveryReview recoveryReceipt"><div><span className="kicker">Previous placement</span><strong>Receipt {lifecycle.receipt.receiptId}</strong><small>This lifecycle does not match the current source, selected artifact, and destination. It is not current send success.{lifecycle.receipt.undoAvailable ? " Undo remains available from authority." : ""}</small></div>{lifecycle.receipt.undoAvailable && <div className="deliveryActions"><button className="secondaryAction" onClick={() => void undoAudiotoolDelivery()}>Undo Send</button></div>}</div>
        )}
        {bundleLifecycle && <details className="receiptEvidence">
          <summary><span>Bundle placement evidence</span><small>{bundleLifecycle.members.length} member {bundleLifecycle.members.length === 1 ? "record" : "records"} · exact receipts and Nexus IDs</small></summary>
          <ol>
            {bundleLifecycle.members.map((member, index) => <li key={member.operationId}>
              <strong>{index + 1}. {libraryCandidates.find((candidate) => candidate.candidateId === member.candidateId)?.title || member.name}</strong>
              <code>operation {member.operationId}</code>
              <code>artifact {member.artifactId}</code>
              <code>sha256 {member.sourceSha256}</code>
              {member.receipt && <>
                <code>receipt {member.receipt.receiptId}</code>
                <code>track {member.receipt.created.trackId}</code>
                <code>region {member.receipt.created.regionId}</code>
              </>}
              {member.shapeReceipts?.map((shape) => <code key={shape.operationId}>shape {shape.operationId} · {shape.beforePositionTicks} → {shape.afterPositionTicks} ticks · {shape.bars > 0 ? "+" : ""}{shape.bars} bar{Math.abs(shape.bars) === 1 ? "" : "s"}</code>)}
              {member.pendingShape && <code>pending shape {member.pendingShape.operationId} · target {member.pendingShape.targetPositionTicks} ticks</code>}
            </li>)}
          </ol>
        </details>}
        <div className="tech-grid">
          <dl className="tech-list">
            <div><dt>Session revision</dt><dd>{sharedSession ? `r${sharedSession.revision}` : "not connected"}</dd></div>
            <div><dt>Shared source SHA-256</dt><dd><code>{sharedSession?.source?.sha256 || "none"}</code></dd></div>
            <div><dt>Source availability</dt><dd>{sharedSession?.sourceAvailability || "unknown"}</dd></div>
            <div><dt>Selected artifact</dt><dd>{sharedSession ? `${selectedArtifactLabel(sharedSession)} (${sharedSession.selectedArtifactId})` : "none"}</dd></div>
            <div><dt>Staged source artifact</dt><dd>{sharedSession?.stagedSourceArtifactId || "none"}</dd></div>
            <div><dt>Chosen candidate</dt><dd>{libraryState.chosenCandidateId || "none"}</dd></div>
            <div><dt>Kept candidates</dt><dd>{libraryState.heldCandidateIds.length ? libraryState.heldCandidateIds.join(", ") : "none"}</dd></div>
            <div><dt>Bundle</dt><dd>{libraryState.activeBundle ? `${libraryState.activeBundle.bundleId} · ${libraryState.activeBundle.candidateIds.length} members` : "none"}</dd></div>
            <div><dt>Bundle delivery</dt><dd>{bundleLifecycle ? `${bundleLifecycle.status} · ${bundleVerifiedCount}/${bundleLifecycle.members.length} verified` : pendingBundleReview ? "NEEDS_USER" : "none"}</dd></div>
            <div><dt>Audiotool destination</dt><dd>{verifiedDestination ? verifiedDestination.projectUuid : "none"}</dd></div>
            <div><dt>Producer Loop state</dt><dd>{producerLoopStatus}{producerLoop ? ` · r${producerLoop.revision}` : ""}</dd></div>
            <div><dt>Receipt</dt><dd>{bundleLifecycle ? `${bundleVerifiedCount} Bundle member receipt${bundleVerifiedCount === 1 ? "" : "s"}` : lifecycle?.receipt ? `${lifecycle.receipt.receiptId} · ${lifecycle.receipt.status}` : "none"}</dd></div>
            <div><dt>Undo available</dt><dd>{lifecycle?.receipt?.undoAvailable ? "yes" : "no"}</dd></div>
          </dl>
          <div className="tech-provenance">
            <h3>Candidate provenance</h3>
            {libraryCandidates.filter((entry) => entry.candidateId === libraryState.chosenCandidateId || libraryState.heldCandidateIds.includes(entry.candidateId)).length === 0
              ? <p>Nothing held or chosen yet.</p>
              : <ul>{libraryCandidates.filter((entry) => entry.candidateId === libraryState.chosenCandidateId || libraryState.heldCandidateIds.includes(entry.candidateId)).map((entry) => <li key={entry.candidateId}><strong>{entry.title}</strong><br /><code>{entry.candidateId}</code><br /><a href={entry.provenanceUrl}>Provenance</a></li>)}</ul>}
          </div>
        </div>
        <ProducerLoopFlow
          nodes={producerLoop?.nodes || IDLE_PRODUCER_LOOP_NODES}
          revision={producerLoop?.revision ?? sharedSession?.revision ?? 0}
          selectedArtifact={sharedSession ? selectedArtifactLabel(sharedSession) : null}
          destination={verifiedDestination?.projectUuid || null}
          error={deliveryError || toolError || sessionError || null}
          projectionStatus={producerLoopStatus}
        />
      </details>

      <details className="secondaryTools">
        <summary><div><span className="kicker">MORE AUDIO TOOLS</span><strong>Vocal analysis + Ask About Audio</strong><small>Secondary tools stay attached to the same authoritative source and verified destination.</small></div><span className="extensionToggle">Open tools</span></summary>
        <div className="secondaryToolsBody">
      <section className="panel vocalAnalysisPanel" aria-label="Audiotool vocal analysis">
        <div className="panelTitle"><div><span className="kicker">AUDIOTOOL VOCAL ANALYSIS</span><h2>Analyze a vocal already in the verified Audiotool project.</h2></div><span className="safeBadge">{VOCAL_ANALYSIS_AVAILABLE ? "READ-ONLY SOURCE" : "UNAVAILABLE"}</span></div>
        <p className="toolIntro">Fresh-read the project, choose one exact audio region, then run BrickHouse pitch, note, rhythm, energy and spectral analysis. This does not change Audiotool.</p>
        <div className="vocalAnalysisControls">
          <button className="secondaryAction" onClick={() => void refreshAudiotoolRegions()} disabled={!VOCAL_ANALYSIS_AVAILABLE || vocalAnalysisBusy}>Refresh regions</button>
          <select aria-label="Audiotool vocal region" value={selectedVocalRegionId} disabled={!VOCAL_ANALYSIS_AVAILABLE} onChange={(event) => { setSelectedVocalRegionId(event.target.value); setVocalAnalysis(null); }}>
            <option value="">Choose an audio region…</option>
            {audiotoolRegions.map((region) => <option key={region.regionId} value={region.regionId}>{region.displayName || "Audio region"}{region.durationSeconds ? ` · ${region.durationSeconds.toFixed(1)} s` : ""}</option>)}
          </select>
          <button className="primaryAction" disabled={!VOCAL_ANALYSIS_AVAILABLE || !selectedVocalRegionId || vocalAnalysisBusy} onClick={() => void analyzeVocalRegion()}>{vocalAnalysisBusy ? "Analyzing…" : "Analyze Vocal"}</button>
        </div>
        {vocalAnalysisError && <p className="error" role="alert">{vocalAnalysisError}</p>}
        {vocalAnalysis && (() => {
          const pitchStability = nestedNumber(vocalAnalysis.acoustics, "pitch", "score");
          const medianPitch = nestedNumber(vocalAnalysis.acoustics, "pitch", "median");
          const voicedRatio = nestedNumber(vocalAnalysis.acoustics, "pitch", "voiced_ratio");
          const energy = nestedNumber(vocalAnalysis.acoustics, "energy", "score");
          const rhythm = nestedNumber(vocalAnalysis.acoustics, "rhythm", "score");
          const tempo = nestedNumber(vocalAnalysis.acoustics, "tempo");
          const brightness = nestedNumber(vocalAnalysis.acoustics, "spectral", "centroid");
          const drift = nestedNumber(vocalAnalysis.halves, "summary", "pitch_median_delta");
          const noteCount = nestedNumber(vocalAnalysis.notes, "note_count");
          return <div className="vocalResult" role="status">
            <div className="vocalResultHeader"><div><span className="kicker">VERIFIED VOCAL ANALYSIS</span><strong>{vocalAnalysis.displayName || "Audiotool audio region"}</strong><small>Exact source {vocalAnalysis.sourceSha256.slice(0, 12)}… · {vocalAnalysis.durationSeconds?.toFixed(1) || "—"} s</small></div><span className="verifiedMark">✓ Source verified</span></div>
            <div className="vocalMetricGrid">
              <div><span>PITCH STABILITY</span><strong>{pitchStability === null ? "—" : `${pitchStability}/100`}</strong></div>
              <div><span>MEDIAN PITCH</span><strong>{medianPitch === null ? "—" : `${medianPitch.toFixed(1)} Hz`}</strong></div>
              <div><span>VOICED</span><strong>{voicedRatio === null ? "—" : `${(voicedRatio * 100).toFixed(0)}%`}</strong></div>
              <div><span>ENERGY</span><strong>{energy === null ? "—" : `${energy}/100`}</strong></div>
              <div><span>RHYTHM</span><strong>{rhythm === null ? "—" : `${rhythm}/100`}</strong></div>
              <div><span>TEMPO</span><strong>{tempo === null ? "—" : `${tempo.toFixed(1)} BPM`}</strong></div>
              <div><span>BRIGHTNESS</span><strong>{brightness === null ? "—" : `${brightness.toFixed(0)} Hz`}</strong></div>
              <div><span>HALF-TO-HALF PITCH Δ</span><strong>{drift === null ? "—" : `${drift.toFixed(1)} Hz`}</strong></div>
              <div><span>DETECTED NOTES</span><strong>{noteCount === null ? "—" : noteCount}</strong></div>
            </div>
          </div>;
        })()}
      </section>

      <section className="panel audioConversationPanel" aria-label="Ask About Audio">
        <div className="panelTitle"><div><span className="kicker">ASK ABOUT AUDIO</span><h2>Keep one conversation with the exact current source.</h2></div><span className="safeBadge">{ASK_ABOUT_AUDIO_AVAILABLE ? "SOURCE-BOUND" : "UNAVAILABLE"}</span></div>
        <p className="toolIntro">Ask naturally. BrickHouse routes each question to the right audio specialist while keeping the conversation tied to the shared source and selected result.</p>
        <div className="audioConversation">
          {(sharedSession?.conversation?.turns || []).length ? (sharedSession?.conversation?.turns || []).map((turn) => <article key={turn.id} className={`audioTurn audioTurn${turn.role === "user" ? "User" : "Assistant"}`}><span>{turn.role === "user" ? "YOU" : "BRICKHOUSE"}</span><p>{turn.content}</p></article>) : <p className="empty">Ask about the vocal, mix, lyrics, pitch, tempo, arrangement, or anything else in the current audio.</p>}
        </div>
        <div className="audioAskComposer">
          <textarea id="ask-input" aria-label="Question about current audio" value={audioQuestion} onChange={(event) => setAudioQuestion(event.target.value)} maxLength={4000} rows={3} placeholder="Why does the hook feel bigger than the verse?" disabled={!ASK_ABOUT_AUDIO_AVAILABLE || !sharedSession?.source || audioAskBusy} />
          <div className="audioAskActions">
            <label className="researchApproval"><input type="checkbox" checked={researchAudioApproved} onChange={(event) => setResearchAudioApproved(event.target.checked)} /><span><strong>Allow research-only reasoning for this source</strong><small>I confirm this audio is approved for non-commercial research analysis. Restricted reasoning never runs silently.</small></span></label>
            <button className="primaryAction" disabled={!ASK_ABOUT_AUDIO_AVAILABLE || !sharedSession?.source || !audioQuestion.trim() || audioAskBusy} onClick={() => void askAboutAudio()}>{audioAskBusy ? "Asking…" : "Ask About Audio"}</button>
          </div>
        </div>
        {audioAskError && <p className="error" role="alert">{audioAskError}</p>}
      </section>

        </div>
      </details>

      <details className="studioExtensions systemDetails"><summary><div><span className="kicker">System details</span><strong>Analysis + studio extensions</strong><small>Signal metrics · EQ/DeEsser · STUDIO EXTENSIONS · protected DAW controls</small></div><span className="extensionToggle">Open details</span></summary><div className="studioExtensionsBody">{analysis && <section className="panel analysisDetails"><div className="metrics"><div><span>PEAK</span><strong>{analysis.peakDb.toFixed(1)} dBFS</strong></div><div><span>RMS</span><strong>{analysis.rmsDb.toFixed(1)} dBFS</strong></div><div><span>CREST</span><strong>{analysis.crestDb.toFixed(1)} dB</strong></div><div><span>ZCR</span><strong>{analysis.zcr.toFixed(4)}</strong></div></div><div className="bars">{Object.entries(analysis.balance).map(([key, value]) => <div className="barRow" key={key}><span>{key}</span><div className="barTrack"><b style={{width:`${Math.min(100, value * 100)}%`}} /></div><small>{(value * 100).toFixed(1)}%</small></div>)}</div></section>}<section className="recommendations"><article className="panel"><div className="panelTitle"><div><span className="kicker">AGENT EQ</span><h2>Starter moves</h2></div><span className="mutedBadge">EAR CHECK REQUIRED</span></div>{!recs ? <p className="empty">No recommendation without measured audio.</p> : <ol>{recs.eq.map((move) => <li key={move}>{move}</li>)}</ol>}</article><article className="panel"><div className="panelTitle"><div><span className="kicker">AGENT DEESSER</span><h2>Sibilance starter</h2></div><span className="mutedBadge">HUMAN APPROVAL</span></div>{!recs ? <p className="empty">No recommendation without measured audio.</p> : <div className="deesserGrid"><div><span>FREQ</span><strong>{(recs.deesser.frequency / 1000).toFixed(1)} kHz</strong></div><div><span>THRESH</span><strong>{recs.deesser.threshold.toFixed(1)} dB</strong></div><div><span>RANGE</span><strong>{recs.deesser.range.toFixed(1)} dB</strong></div><div><span>Q</span><strong>2.0</strong></div></div>}</article></section><section className="panel controlPanel"><div><span className="kicker">DAW + ARA</span><h2>Protected studio controls</h2><p>Pro Tools, Logic, plugin instances, ARA, routing, M4/M2 and provider details remain secondary and exact-target controlled.</p></div><div className="controlActions"><button disabled>Apply EQ</button><button disabled>Apply DeEsser</button><button disabled>Open ARA Control</button></div></section></div></details>
        </div>
      </details>

      <footer>
        <span>BrickHouse Audio Workbench</span>
        <span>Shared session · human send only</span>
      </footer>
    </main>
  );
}
