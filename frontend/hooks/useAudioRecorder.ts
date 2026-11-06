import { useCallback, useEffect, useRef } from 'react';
import { encodeWav } from '../lib/wav';

const SAMPLE_RATE = 16000; // plenty for speech, and small to upload
// The whole recording is kept for at most this long (it can go with a question when it's sent).
// Pieces go on for as long as listening does.
const MAX_SECONDS = 300;
// How long to wait for a mic that is still opening (say, its permission prompt is still showing).
const OPEN_WAIT_MS = 1000;
// Runs on the audio thread and passes each block of samples back to the page.
const TAP = `registerProcessor('tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) this.port.postMessage(samples.slice(0));
    return true;
  }
});`;

/**
 * When the recording is cut into a piece for Gemini, in seconds: at a quiet moment (`quiet` long)
 * once the piece is `min` long, or at the quietest moment of its last second once it's `max`
 * long. `silence`: how long the sound must have been quiet before "stop after silence" stops.
 * Tests change these through window.__pieceTimings, and cut pieces with window.__cutPiece(),
 * which says whether there was anything to cut.
 */
const TIMINGS = { min: 3, max: 8, quiet: 0.2, silence: 1.5 };
type Timings = typeof TIMINGS;
type TestWindow = Window & { __pieceTimings?: Partial<Timings>; __cutPiece?: () => boolean };
const timings = (): Timings => ({ ...TIMINGS, ...(window as TestWindow).__pieceTimings });

// Quieter than this is silence, whatever else is playing.
const FLOOR = 0.003;
// Quiet means a tenth as loud as the speech just before, which fades over a few seconds.
const QUIET_SHARE = 0.1;
const FADE = 0.9986; // per block of 128 samples (8 ms): halves in about 4 seconds
// Given a piece with no one speaking in it, Gemini makes words up, so such a piece isn't sent. A
// piece has speech in it if it's loud for a syllable's length (64 ms) or more, 0.1 s in all: louder
// than SPEECH_LEVEL and twice its quietest fifth, which steady sounds (a fan, a hum) and clicks
// aren't.
const SPEECH_LEVEL = 0.01;
const SYLLABLE_BLOCKS = 8;
const SPEECH_BLOCKS = 12;

/** A piece of the recording, cut at a quiet moment. */
export type Piece = { samples: Float32Array; seconds: number; speech: boolean };

type Recording = {
  stream: MediaStream;
  context: AudioContext;
  /** The whole recording, up to MAX_SECONDS. */
  chunks: Float32Array[];
  length: number;
  /** The piece being recorded: its blocks and how loud each is. */
  blocks: Float32Array[];
  levels: number[];
  /** How loud the recent speech was, fading over time. */
  peak: number;
  /** How many blocks in a row have been quiet. */
  quietBlocks: number;
  onPiece?: (piece: Piece) => void;
  /** For tests: cuts the piece now. */
  cutNow?: () => boolean;
};

/**
 * Records the microphone (with the browser's noise suppression, echo cancellation and automatic
 * volume) or a shared tab's sound as 16 kHz mono. Given onPiece, it also cuts the recording into
 * pieces at quiet moments as it goes, for Gemini to write down one by one. If the mic can't be
 * opened, recording quietly does nothing and the live transcript is used as before.
 */
export function useAudioRecorder() {
  const recordingRef = useRef<Promise<Recording | null> | null>(null);
  const openedRef = useRef<Recording | null>(null);

  /** Starts recording the mic, or `track` (a shared tab's sound) if given. Resolves to whether it could. */
  const start = useCallback(async (track?: MediaStreamTrack, onPiece?: (piece: Piece) => void) => {
    if (recordingRef.current) return true;
    const pending = openRecording(track, onPiece).catch(() => null);
    recordingRef.current = pending;
    const recording = await pending;
    if (recordingRef.current === pending) openedRef.current = recording;
    return Boolean(recording);
  }, []);

  /** Stops recording, hands on its last piece, and returns the whole recording (null if nothing was recorded). */
  const stop = useCallback(async () => {
    const pending = recordingRef.current;
    recordingRef.current = null;
    openedRef.current = null;
    if (!pending) return null;
    const recording = await openedSoon(pending);
    if (!recording) {
      // Still opening, so nothing was recorded. Close it once it opens.
      void pending.then(late => late && closeRecording(late));
      return null;
    }
    closeRecording(recording);
    if (recording.blocks.length) cut(recording, recording.blocks.length);
    return toWav(recording.chunks, recording.length);
  }, []);

  /** Stops recording and throws the audio away. */
  const cancel = useCallback(() => {
    const pending = recordingRef.current;
    recordingRef.current = null;
    openedRef.current = null;
    void pending?.then(recording => recording && closeRecording(recording));
  }, []);

  /** Whether the sound has been quiet long enough for "stop after silence" (true if not recording). */
  const isQuiet = useCallback(() => {
    const recording = openedRef.current;
    return !recording || (recording.quietBlocks * 128) / SAMPLE_RATE >= timings().silence;
  }, []);

  useEffect(() => cancel, [cancel]);
  return { start, stop, cancel, isQuiet };
}

/** The recording, or null if the mic is still opening (say, its permission prompt is still showing). */
function openedSoon(pending: Promise<Recording | null>) {
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), OPEN_WAIT_MS));
  return Promise.race([pending, timeout]);
}

function join(chunks: Float32Array[], length: number) {
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

function toWav(chunks: Float32Array[], length: number) {
  return length ? encodeWav(join(chunks, length), SAMPLE_RATE) : null;
}

/** Whether a piece, going by how loud each of its blocks is, may have someone speaking in it. */
function hasSpeech(levels: number[]) {
  const sorted = [...levels].sort((a, b) => a - b);
  const loud = Math.max(SPEECH_LEVEL, 2 * sorted[Math.floor(sorted.length / 5)]);
  let run = 0;
  let voiced = 0;
  for (const level of levels) {
    run = level > loud ? run + 1 : 0;
    if (run === SYLLABLE_BLOCKS) voiced += run;
    else if (run > SYLLABLE_BLOCKS) voiced += 1;
  }
  return voiced >= SPEECH_BLOCKS;
}

/** Hands on the piece's first `count` blocks; the rest start the next piece. */
function cut(recording: Recording, count: number) {
  const blocks = recording.blocks.splice(0, count);
  const levels = recording.levels.splice(0, count);
  const length = blocks.reduce((sum, block) => sum + block.length, 0);
  if (!length) return;
  const speech = hasSpeech(levels);
  recording.onPiece?.({ samples: join(blocks, length), seconds: length / SAMPLE_RATE, speech });
}

/** Adds a block of samples, and cuts a piece off when it's time. */
function add(recording: Recording, block: Float32Array) {
  if (recording.length < SAMPLE_RATE * MAX_SECONDS) {
    recording.chunks.push(block);
    recording.length += block.length;
  }
  let sum = 0;
  for (const sample of block) sum += sample * sample;
  const level = Math.sqrt(sum / block.length);
  recording.peak = Math.max(level, recording.peak * FADE);
  const quiet = level < Math.max(FLOOR, recording.peak * QUIET_SHARE);
  recording.quietBlocks = quiet ? recording.quietBlocks + 1 : 0;
  if (!recording.onPiece) return;
  recording.blocks.push(block);
  recording.levels.push(level);
  const { min, max, quiet: pause } = timings();
  const blockSeconds = block.length / SAMPLE_RATE;
  const seconds = recording.blocks.length * blockSeconds;
  if (seconds >= min && recording.quietBlocks * blockSeconds >= pause) {
    // In the middle of the quiet stretch, so no word is cut in two.
    cut(recording, recording.blocks.length - Math.floor(recording.quietBlocks / 2));
  } else if (seconds >= max) {
    // No pause yet: at the quietest moment of the last second (of its second half, if shorter).
    const last = Math.min(Math.round(1 / blockSeconds), Math.floor(recording.levels.length / 2));
    const from = recording.levels.length - last;
    let quietest = from;
    for (let i = from; i < recording.levels.length; i++)
      if (recording.levels[i] < recording.levels[quietest]) quietest = i;
    cut(recording, quietest);
  }
}

async function openRecording(track?: MediaStreamTrack, onPiece?: (piece: Piece) => void): Promise<Recording> {
  // Created right away (still inside the click that started dictation, so the browser lets it
  // play), and set up while the browser opens the mic, so recording starts as soon as it can.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const tapReady = loadTap(context);
  tapReady.catch(() => {}); // handled below; this only stops an early failure being reported as unhandled
  let stream: MediaStream | null = null;
  try {
    stream = track
      ? // A copy of the tab's track, so that closing the recording leaves the tab shared.
        new MediaStream([track.clone()])
      : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
    await tapReady;
    if (context.state === 'suspended') await context.resume();
    const recording: Recording = {
      stream,
      context,
      chunks: [],
      length: 0,
      blocks: [],
      levels: [],
      peak: 0,
      quietBlocks: 0,
      onPiece,
    };
    // One channel in: a tab's stereo sound is mixed down to mono.
    const tap = new AudioWorkletNode(context, 'tap', {
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => add(recording, event.data);
    context.createMediaStreamSource(stream).connect(tap);
    if (onPiece && (window as TestWindow).__pieceTimings)
      (window as TestWindow).__cutPiece = recording.cutNow = () => {
        if (!recording.blocks.length) return false;
        cut(recording, recording.blocks.length);
        return true;
      };
    return recording;
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    void context.close().catch(() => {});
    throw error;
  }
}

async function loadTap(context: AudioContext) {
  const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeRecording(recording: Recording) {
  const test = window as TestWindow;
  if (recording.cutNow && test.__cutPiece === recording.cutNow) delete test.__cutPiece;
  recording.stream.getTracks().forEach(track => track.stop());
  void recording.context.close().catch(() => {});
}
