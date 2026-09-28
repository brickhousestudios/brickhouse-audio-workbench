import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveAudioProcessResult } from "../lib/audio-process-result.ts";
import { analyzeLargeWav, LARGE_WAV_BYTES, shouldUseLargeWavFastPath } from "../lib/local-audio-analysis.ts";

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
}

function makePcmWav({ bits, samples, extensible = false, validBits = bits }) {
  const channels = 1;
  const sampleRate = 48000;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const fmtSize = extensible ? 40 : 16;
  const dataBytes = samples.length * blockAlign;
  const buffer = new ArrayBuffer(12 + 8 + fmtSize + 8 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, validBits, true);
    view.setUint32(40, 0, true);
    view.setUint32(44, 1, true); // KSDATAFORMAT_SUBTYPE_PCM Data1
    view.setUint16(48, 0, true);
    view.setUint16(50, 0x0010, true);
    const guidTail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    guidTail.forEach((value, index) => view.setUint8(52 + index, value));
  }
  const dataChunkOffset = 20 + fmtSize;
  writeAscii(view, dataChunkOffset, "data");
  view.setUint32(dataChunkOffset + 4, dataBytes, true);
  let offset = dataChunkOffset + 8;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    if (bits === 24) {
      let value = Math.round(clipped * 0x7fffff);
      if (value < 0) value += 0x1000000;
      view.setUint8(offset, value & 0xff);
      view.setUint8(offset + 1, (value >>> 8) & 0xff);
      view.setUint8(offset + 2, (value >>> 16) & 0xff);
    } else if (bits === 32) {
      let value;
      if (validBits < 32) {
        value = Math.round(clipped * (2 ** (validBits - 1) - 1)) << (32 - validBits);
      } else {
        value = Math.round(clipped * 0x7fffffff);
      }
      view.setInt32(offset, value, true);
    } else {
      throw new Error(`unsupported fixture bits: ${bits}`);
    }
    offset += bytesPerSample;
  }
  return buffer;
}

test("agent async process result waits for terminal job polling before it resolves", async () => {
  const events = [];
  let releasePoll;
  const expected = { revision: 22 };
  const resultPromise = resolveAudioProcessResult(
    { job: { job_id: "job-123", status: "running" } },
    {
      pollAudioJob: async (jobId) => {
        events.push(`poll:${jobId}`);
        return await new Promise((resolve) => { releasePoll = resolve; });
      },
      hydrateSharedSession: (session) => session,
      refreshSharedSession: async () => ({ revision: -1 }),
      setRemoteArtifacts: () => events.push("artifacts"),
      setSelectedArtifactId: () => events.push("selection"),
    },
  );

  let settled = false;
  void resultPromise.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["poll:job-123"]);
  assert.equal(settled, false, "resolver must remain pending while the BrickHouse job is still running");

  releasePoll(expected);
  assert.equal(await resultPromise, expected);
});

test("successful immediate process result keeps the existing session path", async () => {
  const expected = { revision: 23 };
  let polled = false;
  const result = await resolveAudioProcessResult(
    { job: { job_id: "job-124", status: "succeeded" }, session: expected },
    {
      pollAudioJob: async () => { polled = true; return expected; },
      hydrateSharedSession: (session) => session,
      refreshSharedSession: async () => ({ revision: -1 }),
      setRemoteArtifacts: () => {},
      setSelectedArtifactId: () => {},
    },
  );
  assert.equal(result, expected);
  assert.equal(polled, false);
});

test("large WAV analyzer accepts PCM24, PCM32, and WAVE_FORMAT_EXTENSIBLE PCM24-in-32", () => {
  const samples = [-0.75, -0.25, 0, 0.25, 0.75, 0.5, -0.5, 0.125];
  for (const [label, bytes] of [
    ["pcm24.wav", makePcmWav({ bits: 24, samples })],
    ["pcm32.wav", makePcmWav({ bits: 32, samples })],
    ["extensible.wav", makePcmWav({ bits: 32, validBits: 24, extensible: true, samples })],
  ]) {
    const result = analyzeLargeWav(label, bytes);
    assert.equal(result.sampleRate, 48000, label);
    assert.equal(result.channels, 1, label);
    assert.ok(Number.isFinite(result.peakDb), label);
    assert.ok(Number.isFinite(result.rmsDb), label);
    assert.ok(result.duration > 0, label);
  }
});

test("large-WAV fast path never captures browser-decodable compressed formats", () => {
  assert.equal(shouldUseLargeWavFastPath("voice.mp3", LARGE_WAV_BYTES * 4), false);
  assert.equal(shouldUseLargeWavFastPath("song.m4a", LARGE_WAV_BYTES * 4), false);
  assert.equal(shouldUseLargeWavFastPath("take.wav", LARGE_WAV_BYTES), true);
});

test("page wires agent fulfillment through the awaited process resolver and has no compressed bypass", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const agentStart = source.indexOf("const fulfillPendingAgentRequest");
  const agentEnd = source.indexOf("}, [sourceFile", agentStart);
  assert.ok(agentStart >= 0 && agentEnd > agentStart);
  const agentBlock = source.slice(agentStart, agentEnd);
  const resolveIndex = agentBlock.indexOf("resolveAudioProcessResult");
  const fulfillIndex = agentBlock.indexOf("/fulfill");
  assert.ok(resolveIndex >= 0, "agent path must use the shared process-result resolver");
  assert.ok(fulfillIndex > resolveIndex, "agent request must fulfill only after the resolver completes");

  const loadStart = source.indexOf("async function loadAudioFile");
  const loadEnd = source.indexOf("function pickAudio", loadStart);
  const loadBlock = source.slice(loadStart, loadEnd);
  assert.doesNotMatch(loadBlock, /isCompressedSource/);
  assert.match(loadBlock, /shouldUseLargeWavFastPath/);
  assert.match(loadBlock, /decodeAudioData/);
  assert.match(loadBlock, /publishSharedSource\(file, measured, sha256\)/);
  assert.doesNotMatch(loadBlock, /\/api\/audio\/artifacts\/stage/);
  assert.doesNotMatch(loadBlock, /\/api\/audio\/process/);
});
