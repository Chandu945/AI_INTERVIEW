import { useCallback, useEffect, useRef, useState } from 'react';

// Chrome's screen-sharing options that TypeScript's types don't include yet.
type FocusController = { setFocusBehavior: (behavior: 'focus-captured-surface' | 'no-focus-change') => void };
type ShareOptions = {
  video: MediaTrackConstraints;
  audio: MediaTrackConstraints & { suppressLocalAudioPlayback?: boolean };
  controller?: FocusController;
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
};

const canShare = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/**
 * The sound of another browser tab (say, a YouTube video or a Meet call), to listen to instead of
 * the microphone. The first connect() opens Chrome's share picker. The tab then stays shared, so
 * listening again doesn't ask again, until disconnect() or Chrome's own "Stop sharing" button,
 * which calls onEnded.
 */
export function useTabAudio(onEnded: () => void) {
  const [supported, setSupported] = useState(false);
  const [shared, setShared] = useState(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const pendingRef = useRef<Promise<MediaStreamTrack> | null>(null);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  /** The shared tab's sound, asking which tab to share if none is. Fails with a message for the user. */
  const connect = useCallback((): Promise<MediaStreamTrack> => {
    const current = trackRef.current;
    if (current?.readyState === 'live') return Promise.resolve(current);
    if (!pendingRef.current) {
      pendingRef.current = shareTab()
        .then(track => {
          track.addEventListener('ended', () => {
            if (trackRef.current !== track) return; // disconnect() already let it go
            trackRef.current = null;
            setShared(false);
            onEndedRef.current();
          });
          trackRef.current = track;
          setShared(true);
          return track;
        })
        .finally(() => {
          pendingRef.current = null;
        });
    }
    return pendingRef.current;
  }, []);

  /** Stops sharing the tab. */
  const disconnect = useCallback(() => {
    const track = trackRef.current;
    trackRef.current = null;
    setShared(false);
    track?.stop();
  }, []);

  useEffect(() => {
    setSupported(canShare());
    return disconnect;
  }, [disconnect]);

  return { supported, shared, connect, disconnect };
}

async function shareTab(): Promise<MediaStreamTrack> {
  if (!canShare()) throw new Error("This browser can't share a tab's sound. Use Chrome on a computer.");
  const Controller = (window as { CaptureController?: new () => FocusController }).CaptureController;
  const controller = Controller ? new Controller() : undefined;
  const options: ShareOptions = {
    // Chrome shares a tab's sound only along with its picture, which is dropped below.
    video: { displaySurface: 'browser' }, // open the picker on its list of tabs
    // Keep the tab playing out loud, and take its sound as it is: the mic's filters can garble it.
    audio: {
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    controller,
    selfBrowserSurface: 'exclude', // don't offer this app's own tab
    surfaceSwitching: 'include', // let Chrome's sharing bar switch to another tab
    systemAudio: 'include', // when sharing a whole screen, offer the computer's sound where Chrome can
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      throw new Error('No tab was shared. Press Listen to tab and pick the tab that is playing.');
    throw new Error(`Couldn't share the tab (${error instanceof Error ? error.name : 'unknown error'}).`);
  }
  try {
    controller?.setFocusBehavior('no-focus-change'); // stay in the app after picking
  } catch {
    /* not possible for every kind of share */
  }
  stream.getVideoTracks().forEach(track => track.stop());
  const [track] = stream.getAudioTracks();
  if (!track)
    throw new Error('No sound was shared. Press Listen to tab, pick the tab, and keep "Also share tab audio" on.');
  return track;
}
