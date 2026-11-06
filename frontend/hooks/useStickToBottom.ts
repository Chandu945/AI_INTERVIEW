import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeps the newest answer in view while it streams in, but only while the reader is at the
 * bottom. Scrolling up pauses following and scrolling back down resumes it; followNewest()
 * resumes it too (used when a question is asked or an interview is opened). Only an upward
 * scroll pauses it, so text arriving mid-scroll can't switch following off.
 */
export function useStickToBottom(messages: unknown, busy: boolean) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  // Last scroll positions seen, to tell when the reader scrolls up.
  const panelTopRef = useRef(0);
  const pageTopRef = useRef(0);

  const onPanelScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.scrollTop;
    if (top < panelTopRef.current - 1) stickRef.current = false;
    else if (body.scrollHeight - top - body.clientHeight <= 32) stickRef.current = true;
    panelTopRef.current = top;
  }, []);

  // On narrow screens the answer panel doesn't scroll on its own; the whole page does.
  const onPageScroll = useCallback(() => {
    const body = bodyRef.current, marker = bottomRef.current;
    if (!body || !marker) return;
    const top = window.scrollY;
    if (body.scrollHeight <= body.clientHeight + 1) {
      if (top < pageTopRef.current - 1) stickRef.current = false;
      else if (marker.getBoundingClientRect().top <= window.innerHeight + 32) stickRef.current = true;
    }
    pageTopRef.current = top;
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', onPageScroll, { passive: true });
    return () => window.removeEventListener('scroll', onPageScroll);
  }, [onPageScroll]);

  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
    // Our own scroll isn't the reader scrolling up, so compare later scrolls against where it left things.
    panelTopRef.current = bodyRef.current?.scrollTop ?? 0;
    pageTopRef.current = window.scrollY;
  }, [messages, busy]);

  const followNewest = useCallback(() => { stickRef.current = true; }, []);

  return { bodyRef, bottomRef, onPanelScroll, followNewest };
}
