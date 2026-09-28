# BrickHouse: an AI co-producer that works inside Audiotool

**Let's Build 2026 · Categories: Connect (DAW Integration), Sound Design**

BrickHouse lets a producer find sounds in Audiotool's own library, place them in a live Audiotool session, and then shape the mix with an AI engineer that **listens to the real audio, makes native EQ and effect moves, and proves the result**. A human approves every write.

Demo video: `BrickHouse-Demo-FULL.mp4` (about 3 min)

---

## What it does

### 1. Find it: Audio Workbench
- Searches the **Audiotool sample catalog** through the Nexus Samples API (for example `dusty percussion`, Loops, around 92 BPM).
- Streams real previews with waveforms. Nothing touches the project while you audition.
- **Use This → Review & Send → Confirm Send.** The final write is a human-only action.
- The sample lands as a native Audiotool track in the connected project. In the demo, an 87 BPM loop placed in a 137 BPM project stays on the bar grid.
- The destination is verified against the exact open Audiotool tab. If the target changes between review and send, the send is refused.

### 2. Listen and fix: native Curve EQ with live spectrum
- BrickHouse inserts Audiotool's own **Curve** EQ into a track's chain through Nexus in one typed transaction, with no manual cabling.
- It reads the Curve's live **pre/post FFT spectrum** straight from the Audiotool runtime.
- In the demo the producer says the piano sounds muddy. BrickHouse finds the build-up at **~340 Hz** and, on approval, cuts it on the real Curve (340 Hz, -4 dB, Q 1.5).
- It then **re-listens**. On the same pass, 340 Hz drops about 4 dB after the Curve while the low end at ~86 Hz stays within 1 dB.
- The Curve's title updates itself (`BrickHouse Curve — REV 2 · AGENT: …`) so every agent edit is visible inside Audiotool.

### 3. Shape it: semantic control of native devices
- Producer-language actions ("more feedback, subtle", "room larger", "compression gentler") map to exact native parameters on Audiotool devices, including Mixer Delay/Reverb aux, Pulsar, Quasar, Gravity, Quantum, Graphical EQ, Band Splitter and Centroid.
- Inline insertion supports Curve, Delay, Pitch Delay, Reverb, Pulsar and Quasar.
- Every move follows the same pattern: **plan → apply → fresh Nexus readback → durable receipt → exact undo**.

---

## How it's built

```
Producer ── Audio Workbench (Next.js) ──┐
                                        ├── BrickHouse authority (shared session, receipts, human approval gate)
Agent (MCP) ── BrickHouse MCP tools ────┘
                                        └── Audiotool Nexus SDK (@audiotool/nexus)
                                              ├── Samples API (catalog search, previews)
                                              ├── Document API (tracks, regions, devices, cables)
                                              └── Studio runtime (Curve spectrum, transport)
```

- **UI and MCP parity:** the producer UI and the AI agent operate on the same shared session and the same actions.
- **Exact-target safety:** every write is bound to a verified project UUID and the live browser tab. Stale graphs and stale targets fail closed.
- **Receipts and undo:** each mutation records its before-state, and restore only reverses what BrickHouse itself changed.
- **Human boundary:** sends to Audiotool always require the producer's Confirm Send.

## Running it

- Workbench web app: Next.js; the authority service exposes the MCP endpoint.
- Requires an Audiotool account and a Developer Hub API key, plus the Audiotool project open in a Chromium browser.
- Public build instructions are below; private deployment credentials and protected service endpoints are intentionally not committed.

## Honest limits

- The live spectrum only captures while BrickHouse drives the transport itself (audition loop); it reports no signal while paused.
- Flanger and some other native devices are not yet supported for inline insertion.
- The Workbench's project-connect field is currently hard to find; a top-level "paste your project link" field is next.

## Team

BrickHouse Studios. Built with Claude and OpenAI agents on the Audiotool Nexus SDK.
# Public source snapshot

This repository is the public Let’s Build! 2026 source snapshot for BrickHouse Audio Workbench.

It contains the producer-facing Next.js application, Audiotool delivery boundary, shared transport contracts, authentication guards, local analysis code, and regression tests used by the submission.

The hosted demo also talks to BrickHouse authority and Audiotool control services. Those private deployment services, credentials, protected endpoints, and studio-specific infrastructure are intentionally not included here.

## Build

```bash
npm ci
npm run build
npm run dev
```
