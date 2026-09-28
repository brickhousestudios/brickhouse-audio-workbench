"use client";

import { useEffect, useRef, useState } from "react";

export function formatClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const whole = Math.floor(totalSeconds);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function WaveformBars({
  peaks,
  bars = 72,
  className = "",
}: {
  peaks?: number[] | null;
  bars?: number;
  className?: string;
}) {
  let values: number[];
  if (peaks && peaks.length) {
    values = Array.from({ length: bars }, (_, i) => {
      const v = peaks[Math.floor((i / bars) * peaks.length)] ?? 0;
      return Math.max(0.06, Math.min(1, v));
    });
  } else {
    values = Array.from({ length: bars }, (_, i) => {
      const t = (i / bars) * Math.PI * 4;
      return 0.22 + 0.16 * Math.abs(Math.sin(t)) + 0.08 * Math.abs(Math.sin(t * 2.7 + 1.3));
    });
  }
  return (
    <div className={`wavebars ${className}`} aria-hidden="true">
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.round(v * 100)}%` }} />
      ))}
    </div>
  );
}

type CustomPlayerProps = {
  src: string | null;
  audioLabel: string;
  peaks?: number[] | null;
  layout?: "source" | "mini";
  preloadAuto?: boolean;
  registerAudio?: (el: HTMLAudioElement | null) => void;
  onPlayInteraction?: () => void;
  loop?: boolean;
  onLoopToggle?: () => void;
  disabledReason?: string | null;
};

export function CustomPlayer({
  src,
  audioLabel,
  peaks = null,
  layout = "source",
  preloadAuto = false,
  registerAudio,
  onPlayInteraction,
  loop = false,
  onLoopToggle,
  disabledReason = null,
}: CustomPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playable = Boolean(src);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(el.currentTime || 0);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
    };
  }, [src]);

  function toggle() {
    const el = audioRef.current;
    if (!el || !src) return;
    if (el.paused) {
      onPlayInteraction?.();
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }

  function seek(value: number) {
    const el = audioRef.current;
    if (!el || !Number.isFinite(value)) return;
    el.currentTime = Math.max(0, Math.min(duration || 0, value));
    setCurrentTime(el.currentTime);
  }

  const actionLabel = playing ? `Pause ${audioLabel}` : `Play ${audioLabel}`;
  return (
    <div className={`cplayer cplayer-${layout}${playable ? "" : " cplayer-idle"}`}>
      <button
        type="button"
        className="cplayer-play"
        aria-label={actionLabel}
        aria-pressed={playing}
        title={actionLabel}
        disabled={!playable}
        onClick={toggle}
      >
        <span aria-hidden="true">{playing ? "\u275A\u275A" : "\u25B6"}</span>
      </button>
      {onLoopToggle && (
        <button
          type="button"
          className={`cplayer-loop${loop ? " is-looping" : ""}`}
          aria-label={loop ? `Turn off loop for ${audioLabel}` : `Loop ${audioLabel}`}
          aria-pressed={loop}
          title={loop ? "Loop on" : "Loop"}
          disabled={!playable}
          onClick={onLoopToggle}
        >
          <span aria-hidden="true">↻</span>
          <small>{loop ? "Looping" : "Loop"}</small>
        </button>
      )}
      <div className="cplayer-body">
        <div className="cplayer-wavewrap">
          <WaveformBars peaks={peaks} className={playing ? "is-playing" : ""} />
          <input
            type="range"
            className="cplayer-seek"
            aria-label={`Seek ${audioLabel}`}
            aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration > 0 ? duration : null)}`}
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.1}
            value={duration > 0 ? Math.min(currentTime, duration) : 0}
            disabled={!playable || duration <= 0}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </div>
        <div className="cplayer-meta">
          <span className="cplayer-time">
            {formatClock(currentTime)} / {formatClock(duration > 0 ? duration : null)}
          </span>
          {!playable && disabledReason && <span className="cplayer-hint">{disabledReason}</span>}
        </div>
      </div>
      <audio
        ref={(node) => {
          audioRef.current = node;
          registerAudio?.(node);
        }}
        preload={preloadAuto ? "auto" : "metadata"}
        src={src || undefined}
        loop={loop}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

export type AuditionCandidate = {
  candidateId: string;
  providerId: string;
  title: string;
  bpm: number;
  key: string;
  uploader: string;
  instruments: string[];
  fitCategories: string[];
  tempoDeltaBpm?: number | null;
  provider?: string;
  kind?: string;
  durationSeconds?: number;
  waveformUrl?: string | null;
};

/** Real waveform peaks for a native Audiotool sample (Audiotool CDN, read-only). */
function useNativeWaveform(url: string | null | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    let active = true;
    fetch(url).then((response) => response.ok ? response.json() : null).then((data) => {
      if (!active || !Array.isArray(data) || !data.length) return;
      const values = data.map((value: unknown) => Math.abs(Number(value)) || 0);
      const max = Math.max(...values) || 1;
      setPeaks(values.map((value) => value / max));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [url]);
  return peaks;
}

type CandidateCardProps = {
  candidate: AuditionCandidate;
  previewUrl: string;
  prefetchAudio: boolean;
  active: boolean;
  focused: boolean;
  held: boolean;
  bundled: boolean;
  bundlePosition: number | null;
  chosen: boolean;
  playbackBlocked: boolean;
  looping: boolean;
  busy: boolean;
  stateNote: string | null;
  onFocusCandidate: () => void;
  onPlay: () => void;
  onLoopToggle: () => void;
  onHold: () => void;
  onBundleToggle: () => void;
  onUse: () => void;
  registerAudio: (candidateId: string, el: HTMLAudioElement | null) => void;
};

export function CandidateCard({
  candidate,
  previewUrl,
  prefetchAudio,
  active,
  focused,
  held,
  bundled,
  bundlePosition,
  chosen,
  playbackBlocked,
  looping,
  busy,
  stateNote,
  onFocusCandidate,
  onPlay,
  onLoopToggle,
  onHold,
  onBundleToggle,
  onUse,
  registerAudio,
}: CandidateCardProps) {
  const native = candidate.provider === "audiotool";
  const nativePeaks = useNativeWaveform(native ? candidate.waveformUrl : null);
  const cardLabel = native
    ? `${candidate.title}, Audiotool catalog ${candidate.kind || "sample"}${candidate.bpm ? `, ${candidate.bpm} beats per minute` : ""}`
    : `${candidate.title}, ${candidate.bpm} beats per minute, key ${candidate.key}`;

  return (
    <article
      className={`cand${focused ? " cand-focused" : ""}${active ? " cand-active" : ""}${held ? " cand-held" : ""}${bundled ? " cand-bundled" : ""}${chosen ? " cand-chosen" : ""}`}
      aria-current={focused ? "true" : undefined}
      aria-label={`${cardLabel}${focused ? ", focused" : ""}`}
      onClick={onFocusCandidate}
      onFocusCapture={onFocusCandidate}
    >
      <div className="cand-top" aria-hidden="true" />
      <div className="cand-head">
        <div className="cand-heading-row">
          <p className="cand-kicker">
            {native
              ? <>{candidate.bpm ? `${candidate.bpm} BPM` : "One-shot"} · {candidate.kind} · {formatClock(candidate.durationSeconds ?? 0)} · <span className="cand-native">Audiotool catalog</span></>
              : <>{candidate.bpm} BPM · {candidate.key}</>}
          </p>
          <button
            type="button"
            className={`cand-hold${held ? " is-held" : ""}`}
            aria-pressed={held}
            aria-label={held ? `Remove ${candidate.title} from kept sounds` : `Keep ${candidate.title}`}
            title={held ? "Remove from kept sounds" : "Keep this sound"}
            disabled={busy}
            onClick={onHold}
          >
            <span aria-hidden="true">{held ? "★" : "☆"}</span>
          </button>
        </div>
        <h3 className="cand-title">{candidate.title}</h3>
        <p className="cand-tags">
          {candidate.instruments.slice(0, 3).map((value) => (
            <span key={value}>{value.replace(/_/g, " ")}</span>
          ))}
          {candidate.fitCategories.slice(0, 2).map((value) => (
            <span key={value}>{value.replace(/_/g, " ")}</span>
          ))}
        </p>
      </div>
      <CustomPlayer
        layout="mini"
        src={previewUrl}
        audioLabel={`Preview ${candidate.title}`}
        peaks={nativePeaks}
        preloadAuto={prefetchAudio}
        registerAudio={(el) => registerAudio(candidate.candidateId, el)}
        onPlayInteraction={onPlay}
        loop={looping}
        onLoopToggle={onLoopToggle}
      />
      {(chosen || held || bundled || playbackBlocked || stateNote) && (
        <p className="cand-state">
          {chosen && <strong>Private to you — nothing sent yet</strong>}
          {!chosen && held && <strong>Kept</strong>}
          {bundled && <span>{bundlePosition ? `Bundle · ${bundlePosition}` : "In Bundle"}</span>}
          {!chosen && playbackBlocked && <strong>Ready — press Play for sound</strong>}
          {stateNote && <span>{stateNote}</span>}
        </p>
      )}
      <div className="cand-actions">
        {chosen ? (
          <span className="cand-selected" role="status" aria-label={`Selected ${candidate.title}`}>Selected ✓</span>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onUse}>Use This</button>
        )}
        <button
          type="button"
          className={`btn btn-ghost cand-bundle${bundled ? " is-bundled" : ""}`}
          aria-pressed={bundled}
          disabled={busy}
          onClick={onBundleToggle}
        >
          {bundled ? "Remove" : "+ Bundle"}
        </button>
      </div>
    </article>
  );
}

export function IntentComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  needSource,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  needSource: boolean;
  busy: boolean;
}) {
  return (
    <form
      className="intent"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="intent-row">
        <input
          id="intent-input"
          type="text"
          autoComplete="off"
          maxLength={500}
          placeholder='Try "dark melodic" or "more aggressive drums"'
          aria-describedby="intent-hint"
          value={value}
          disabled={disabled || busy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="submit" className="btn btn-primary intent-go" disabled={disabled || busy || !value.trim()}>
          {busy ? "…" : "Go"}
        </button>
      </div>
      <p className="intent-hint sr-only" id="intent-hint">
        {needSource
          ? "Add sound first — then steer it here."
          : "Describe the direction. “Next” works too."}
      </p>
    </form>
  );
}


type AuditionDeckProps = {
  candidates: AuditionCandidate[];
  activeCandidateId: string | null;
  heldCandidateIds: string[];
  bundleCandidateIds: string[];
  chosenCandidateId: string | null;
  playbackBlockedCandidateId: string | null;
  busy: boolean;
  previewUrlFor: (candidate: AuditionCandidate) => string;
  onPlay: (candidateId: string) => void;
  onHold: (candidateId: string) => void;
  onBundleToggle: (candidateId: string, bundled: boolean) => void;
  onUse: (candidateId: string) => void;
  registerAudio: (candidateId: string, el: HTMLAudioElement | null) => void;
};

export function AuditionDeck({
  candidates,
  activeCandidateId,
  heldCandidateIds,
  bundleCandidateIds,
  chosenCandidateId,
  playbackBlockedCandidateId,
  busy,
  previewUrlFor,
  onPlay,
  onHold,
  onBundleToggle,
  onUse,
  registerAudio,
}: AuditionDeckProps) {
  const [focusedCandidateId, setFocusedCandidateId] = useState<string | null>(null);
  const [loopingCandidateId, setLoopingCandidateId] = useState<string | null>(null);
  const [focusAnnouncement, setFocusAnnouncement] = useState("");

  useEffect(() => {
    if (focusedCandidateId && !candidates.some((candidate) => candidate.candidateId === focusedCandidateId)) {
      setFocusedCandidateId(null);
      setFocusAnnouncement("");
    }
    if (loopingCandidateId && !candidates.some((candidate) => candidate.candidateId === loopingCandidateId)) {
      setLoopingCandidateId(null);
    }
  }, [candidates, focusedCandidateId, loopingCandidateId]);

  const focusCandidate = (candidate: AuditionCandidate) => {
    if (focusedCandidateId === candidate.candidateId) return;
    setFocusedCandidateId(candidate.candidateId);
    setFocusAnnouncement(`Focused ${candidate.title}. Play to audition or Use This to stage it.`);
  };

  return (
    <>
      <div className="cand-grid">
        {candidates.map((candidate, index) => (
          <CandidateCard
            key={candidate.candidateId}
            candidate={candidate}
            previewUrl={previewUrlFor(candidate)}
            prefetchAudio={index < 4}
            active={activeCandidateId === candidate.candidateId}
            focused={focusedCandidateId === candidate.candidateId}
            held={heldCandidateIds.includes(candidate.candidateId)}
            bundled={bundleCandidateIds.includes(candidate.candidateId)}
            bundlePosition={bundleCandidateIds.includes(candidate.candidateId) ? bundleCandidateIds.indexOf(candidate.candidateId) + 1 : null}
            chosen={chosenCandidateId === candidate.candidateId}
            playbackBlocked={activeCandidateId === candidate.candidateId && playbackBlockedCandidateId === candidate.candidateId}
            looping={loopingCandidateId === candidate.candidateId}
            busy={busy}
            stateNote={null}
            onFocusCandidate={() => focusCandidate(candidate)}
            onPlay={() => onPlay(candidate.candidateId)}
            onLoopToggle={() => setLoopingCandidateId((current) => current === candidate.candidateId ? null : candidate.candidateId)}
            onHold={() => onHold(candidate.candidateId)}
            onBundleToggle={() => onBundleToggle(candidate.candidateId, bundleCandidateIds.includes(candidate.candidateId))}
            onUse={() => onUse(candidate.candidateId)}
            registerAudio={registerAudio}
          />
        ))}
      </div>
      <p className="sr-only" aria-live="polite">{focusAnnouncement}</p>
    </>
  );
}
