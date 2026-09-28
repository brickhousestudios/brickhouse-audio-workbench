"use client";

export type ProducerLoopNodeState =
  | "NOT_STARTED"
  | "WAITING"
  | "RUNNING"
  | "NEEDS_USER"
  | "VERIFIED"
  | "PARTIAL"
  | "FAILED_SAFE"
  | "OUTCOME_UNKNOWN"
  | "ROLLED_BACK";

export type ProducerLoopNodes = {
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

const ORDER = ["source", "understand", "artifacts", "select", "destination", "review", "send", "verify", "receipt", "undo"] as const;
const LABELS: Record<(typeof ORDER)[number], string> = {
  source: "Source",
  understand: "Understand",
  artifacts: "Artifacts",
  select: "Select",
  destination: "Destination",
  review: "Review",
  send: "Send",
  verify: "Verify",
  receipt: "Receipt",
  undo: "Undo",
};
const COPY: Record<(typeof ORDER)[number], string> = {
  source: "Exact shared audio source is established.",
  understand: "Optional analysis or understanding stays bound to the same source.",
  artifacts: "Original and derived BrickHouse artifacts are available.",
  select: "One exact artifact is selected for the next action.",
  destination: "Audiotool project and exact live target are verified.",
  review: "Human reviews the exact artifact, destination, and operation.",
  send: "Human-approved delivery is applied through BrickHouse/Nexus.",
  verify: "Fresh readback proves the exact remote placement.",
  receipt: "Stable receipt records the verified changed entities.",
  undo: "Receipt-bound compensation preserves unrelated project state.",
};

function visualState(state: ProducerLoopNodeState) {
  if (state === "VERIFIED" || state === "ROLLED_BACK") return "complete";
  if (state === "RUNNING") return "active";
  if (state === "NEEDS_USER") return "needs-user";
  if (state === "FAILED_SAFE" || state === "OUTCOME_UNKNOWN") return "failed";
  if (state === "PARTIAL") return "attention";
  return "waiting";
}

function headline(nodes: ProducerLoopNodes, projectionStatus?: "live" | "loading" | "error" | "unverified") {
  if (projectionStatus === "loading") return "Producer Loop is loading";
  if (projectionStatus === "error" || projectionStatus === "unverified") return "Producer Loop is unverified";
  const priority = ORDER.find((node) => ["OUTCOME_UNKNOWN", "FAILED_SAFE"].includes(nodes[node]));
  if (priority) return `${LABELS[priority]} needs attention`;
  const partial = ORDER.find((node) => nodes[node] === "PARTIAL");
  if (partial) return `${LABELS[partial]} is partial`;
  const human = ORDER.find((node) => nodes[node] === "NEEDS_USER");
  if (human) return `${LABELS[human]} needs you`;
  const running = ORDER.find((node) => nodes[node] === "RUNNING");
  if (running) return `${LABELS[running]} is running`;
  const progressed = ORDER.reduce((last, node, index) => nodes[node] !== "NOT_STARTED" && nodes[node] !== "WAITING" ? index : last, -1);
  const next = ORDER[Math.min(progressed + 1, ORDER.length - 1)];
  return nodes.undo === "ROLLED_BACK" || nodes.undo === "VERIFIED" ? "Producer Loop complete" : `${LABELS[next]} is next`;
}

export const IDLE_PRODUCER_LOOP_NODES: ProducerLoopNodes = {
  source: "NOT_STARTED",
  understand: "NOT_STARTED",
  artifacts: "NOT_STARTED",
  select: "NOT_STARTED",
  destination: "NOT_STARTED",
  review: "NOT_STARTED",
  send: "WAITING",
  verify: "WAITING",
  receipt: "WAITING",
  undo: "WAITING",
};

export function ProducerLoopFlow({
  nodes,
  revision,
  selectedArtifact,
  destination,
  error,
  projectionStatus = "live",
}: {
  nodes: ProducerLoopNodes;
  revision: number;
  selectedArtifact?: string | null;
  destination?: string | null;
  error?: string | null;
  projectionStatus?: "live" | "loading" | "error" | "unverified";
}) {
  const title = headline(nodes, projectionStatus);
  return (
    <section className="producerFlowShell" aria-label="Producer Loop live nodes">
      <header className="producerFlowHeader">
        <div>
          <span className="kicker">PRODUCER LOOP</span>
          <strong>{title}</strong>
          <small>Live authority · revision {revision}</small>
        </div>
        <div className="producerFlowContext">
          {selectedArtifact && <span title={selectedArtifact}>Selected · {selectedArtifact}</span>}
          {destination && <span title={destination}>Audiotool · {destination.slice(0, 8)}…</span>}
        </div>
      </header>
      {error && <div className="producerFlowAlert" role="alert"><strong>Action stopped safely</strong><span>{error}</span></div>}
      <ol className="producerFlowNodes">
        {ORDER.map((node, index) => {
          const state = nodes[node];
          const visual = visualState(state);
          return (
            <li className="producerFlowRow" key={node} data-status={visual}>
              <div className="producerFlowRail" aria-hidden="true">
                <span className="producerFlowNode" data-status={visual}>{index + 1}</span>
                {index < ORDER.length - 1 && <span className="producerFlowConnector" data-status={visual}>{visual === "active" ? <i /> : null}</span>}
              </div>
              <div className="producerFlowCard" data-status={visual}>
                <div><strong>{LABELS[node]}</strong><span>{state.replaceAll("_", " ")}</span></div>
                <small>{COPY[node]}</small>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
