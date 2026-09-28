export type Analysis = {
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  zcr: number;
  balance: Record<string, number>;
  flags: string[];
  waveform: number[];
};

const bands = {
  mud: [160, 220, 300],
  box: [420, 600, 760],
  nasal: [950, 1200, 1450],
  presence: [2000, 2800, 3600],
  harsh: [4500, 5600, 6800, 7600],
  air: [9000, 12000, 15000],
};

export const LARGE_WAV_BYTES = 12 * 1024 * 1024;

export function shouldUseLargeWavFastPath(name: string, size: number) {
  return size >= LARGE_WAV_BYTES && /\.wav$/i.test(name);
}

const db = (value: number) => 20 * Math.log10(Math.max(Math.abs(value), 1e-12));

function goertzel(samples: Float32Array, sr: number, freq: number) {
  if (!samples.length || freq >= sr / 2) return 0;
  const n = samples.length;
  const k = Math.floor(0.5 + (n * freq) / sr);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    s0 = samples[i] * win + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, (s1 * s1 + s2 * s2 - coeff * s1 * s2) / n);
}

function mixDown(buffer: AudioBuffer) {
  const frames = buffer.length;
  const step = Math.max(1, Math.floor(frames / 131072));
  const values: number[] = [];
  for (let i = 0; i < frames; i += step) {
    let sum = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      sum += buffer.getChannelData(channel)[i] || 0;
    }
    values.push(sum / buffer.numberOfChannels);
  }
  return Float32Array.from(values);
}

function summarizeSamples(
  name: string,
  samples: Float32Array,
  sampleRate: number,
  channels: number,
  duration: number,
  spectralWindow: Float32Array,
): Analysis {
  let peak = 0;
  let energy = 0;
  let crossings = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
    if (index && (samples[index - 1] >= 0) !== (value >= 0)) crossings++;
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  const raw: Record<string, number> = {};
  for (const [key, frequencies] of Object.entries(bands)) {
    const valid = frequencies.filter((frequency) => frequency < sampleRate / 2);
    raw[key] = valid.length
      ? valid.reduce((sum, frequency) => sum + goertzel(spectralWindow, sampleRate, frequency), 0) / valid.length
      : 0;
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1e-12;
  const balance = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]));
  const peakDb = db(peak);
  const rmsDb = db(rms);
  const flags: string[] = [];
  if (peakDb > -1) flags.push("near clip");
  if (balance.mud > 0.2) flags.push("mud risk");
  if (balance.box > 0.18) flags.push("box risk");
  if (balance.harsh > 0.16) flags.push("harsh / sibilance risk");
  const waveform = Array.from({ length: 72 }, (_, bin) => {
    const low = Math.floor((bin * samples.length) / 72);
    const high = Math.max(low + 1, Math.floor(((bin + 1) * samples.length) / 72));
    let localPeak = 0;
    for (let index = low; index < high; index++) localPeak = Math.max(localPeak, Math.abs(samples[index] || 0));
    return localPeak;
  });
  return {
    name,
    duration,
    sampleRate,
    channels,
    peakDb,
    rmsDb,
    crestDb: peakDb - rmsDb,
    zcr: crossings / Math.max(1, samples.length - 1),
    balance,
    flags,
    waveform,
  };
}

export function analyzeBuffer(name: string, buffer: AudioBuffer): Analysis {
  const samples = mixDown(buffer);
  const count = Math.min(4096, samples.length);
  const start = Math.max(0, Math.floor((samples.length - count) / 2));
  return summarizeSamples(
    name,
    samples,
    buffer.sampleRate,
    buffer.numberOfChannels,
    buffer.duration,
    samples.slice(start, start + count),
  );
}

type WavFormat = {
  format: number;
  channels: number;
  sampleRate: number;
  bits: number;
  validBits: number;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
};

function parseWavFormat(view: DataView): WavFormat {
  if (
    view.byteLength < 44 ||
    view.getUint32(0, false) !== 0x52494646 ||
    view.getUint32(8, false) !== 0x57415645
  ) {
    throw new Error("Not a WAV file");
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let validBits = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkData + size > view.byteLength) throw new Error("Malformed WAV chunk");

    if (id === "fmt " && size >= 16) {
      format = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      blockAlign = view.getUint16(chunkData + 12, true);
      bits = view.getUint16(chunkData + 14, true);
      validBits = bits;
      if (format === 0xfffe) {
        if (size < 40 || view.getUint16(chunkData + 16, true) < 22) throw new Error("Unsupported WAV format");
        validBits = view.getUint16(chunkData + 18, true) || bits;
        format = view.getUint32(chunkData + 24, true);
      }
    } else if (id === "data") {
      dataOffset = chunkData;
      dataBytes = size;
    }

    offset += 8 + size + (size & 1);
  }

  const bytesPerSample = Math.ceil(bits / 8);
  const minimumFrameBytes = channels * bytesPerSample;
  if (
    !dataOffset ||
    !channels ||
    !sampleRate ||
    !bits ||
    ![1, 3].includes(format) ||
    ![8, 16, 24, 32].includes(bits) ||
    blockAlign < minimumFrameBytes ||
    (format === 3 && bits !== 32)
  ) {
    throw new Error("Unsupported WAV format");
  }

  return { format, channels, sampleRate, bits, validBits, blockAlign, dataOffset, dataBytes };
}

function readPcmSample(view: DataView, offset: number, bits: number, validBits: number) {
  if (bits === 8) return (view.getUint8(offset) - 128) / 128;

  let value: number;
  if (bits === 16) {
    value = view.getInt16(offset, true);
  } else if (bits === 24) {
    value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    if (value & 0x800000) value |= 0xff000000;
  } else {
    value = view.getInt32(offset, true);
  }

  const shift = Math.max(0, bits - validBits);
  if (shift) value >>= shift;
  return value / 2 ** (validBits - 1);
}

export function analyzeLargeWav(name: string, bytes: ArrayBuffer): Analysis {
  const view = new DataView(bytes);
  const wav = parseWavFormat(view);
  const bytesPerSample = Math.ceil(wav.bits / 8);
  const frames = Math.floor(wav.dataBytes / wav.blockAlign);
  if (!frames) throw new Error("WAV file has no audio frames");

  const readSample = (offset: number) => wav.format === 3
    ? view.getFloat32(offset, true)
    : readPcmSample(view, offset, wav.bits, wav.validBits);

  const readFrame = (frame: number) => {
    let sum = 0;
    const frameOffset = wav.dataOffset + frame * wav.blockAlign;
    for (let channel = 0; channel < wav.channels; channel++) {
      sum += readSample(frameOffset + channel * bytesPerSample);
    }
    return sum / wav.channels;
  };

  const step = Math.max(1, Math.floor(frames / 131072));
  const samples = new Float32Array(Math.ceil(frames / step));
  let sampleCount = 0;
  for (let frame = 0; frame < frames; frame += step) samples[sampleCount++] = readFrame(frame);
  const sampled = samples.subarray(0, sampleCount);

  const nativeCount = Math.min(4096, frames);
  const nativeStart = Math.max(0, Math.floor((frames - nativeCount) / 2));
  const spectralWindow = new Float32Array(nativeCount);
  for (let index = 0; index < nativeCount; index++) spectralWindow[index] = readFrame(nativeStart + index);

  return summarizeSamples(
    name,
    sampled,
    wav.sampleRate,
    wav.channels,
    frames / wav.sampleRate,
    spectralWindow,
  );
}
