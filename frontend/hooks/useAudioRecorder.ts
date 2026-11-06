import { useCallback, useEffect, useRef } from 'react';
import { encodeWav } from '../lib/wav';

const SAMPLE_RATE = 16000; // plenty for speech, and small to upload
const MAX_SECONDS = 300;
// How long to wait for a mic that is still opening (say, its permission prompt is still showing).
const OPEN_WAIT_MS = 1000;
// Runs on the audio thread and passes each block of microphone samples back to the page.
const TAP = `registerProcessor('tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) this.port.postMessage(samples.slice(0));
    return true;
  }
});`;

type Recording = { stream: MediaStream; context: AudioContext; chunks: Float32Array[]; length: number };

/**
 * Records the microphone as 16 kHz mono WAV with the browser's noise suppression, echo
 * cancellation and automatic volume, for a second, more accurate transcription. If the mic
 * can't be opened, recording quietly does nothing and the live transcript is used as before.
 */
export function useAudioRecorder() {
  const recordingRef = useRef<Promise<Recording | null> | null>(null);

  const start = useCallback(() => {
    if (!recordingRef.current) recordingRef.current = openRecording().catch(() => null);
  }, []);

  /** Stops recording and returns the audio, or null if nothing was recorded. */
  const stop = useCallback(async () => {
    const pending = recordingRef.current;
    recordingRef.current = null;
    if (!pending) return null;
    const recording = await openedSoon(pending);
    if (!recording) {
      // Still opening, so nothing was recorded. Close it once it opens.
      void pending.then(late => late && closeRecording(late));
      return null;
    }
    closeRecording(recording);
    return toWav(recording);
  }, []);

  /** The audio recorded so far, without stopping. */
  const peek = useCallback(async () => {
    const pending = recordingRef.current;
    const recording = pending && (await openedSoon(pending));
    return recording ? toWav(recording) : null;
  }, []);

  /** Stops recording and throws the audio away. */
  const cancel = useCallback(() => {
    const pending = recordingRef.current;
    recordingRef.current = null;
    void pending?.then(recording => recording && closeRecording(recording));
  }, []);

  useEffect(() => cancel, [cancel]);
  return { start, stop, peek, cancel };
}

/** The recording, or null if the mic is still opening (say, its permission prompt is still showing). */
function openedSoon(pending: Promise<Recording | null>) {
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), OPEN_WAIT_MS));
  return Promise.race([pending, timeout]);
}

function toWav(recording: Recording) {
  if (!recording.length) return null;
  const samples = new Float32Array(recording.length);
  let offset = 0;
  for (const chunk of recording.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return encodeWav(samples, SAMPLE_RATE);
}

async function openRecording(): Promise<Recording> {
  // Created right away (still inside the click that started dictation, so the browser lets it
  // play), and set up while the browser opens the mic, so recording starts as soon as it can.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const tapReady = loadTap(context);
  tapReady.catch(() => {}); // handled below; this only stops an early failure being reported as unhandled
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await tapReady;
    if (context.state === 'suspended') await context.resume();
    const recording: Recording = { stream, context, chunks: [], length: 0 };
    const tap = new AudioWorkletNode(context, 'tap', { numberOfOutputs: 0 });
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (recording.length >= SAMPLE_RATE * MAX_SECONDS) return;
      recording.chunks.push(event.data);
      recording.length += event.data.length;
    };
    context.createMediaStreamSource(stream).connect(tap);
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
  recording.stream.getTracks().forEach(track => track.stop());
  void recording.context.close().catch(() => {});
}
