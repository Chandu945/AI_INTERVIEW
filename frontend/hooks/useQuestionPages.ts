import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The answer panel shows one question and its answer at a time: each is a page at least as tall
 * as the inside of the panel (--page-height), and scrolling snaps from page to page (see .qa-page
 * in style.css). showNewest() brings the newest page to the top of the panel after the next
 * render, for a question just asked or an interview just opened; the view then stays there while
 * the answer streams in. On narrow screens, where the whole page scrolls instead of the panel,
 * the newest question is brought to the top of the screen.
 */
export function useQuestionPages(messages: unknown) {
  // The panel's scrolling body, as a state, so the effects below run again when it mounts.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const showRef = useRef(false);

  // Before the effect below, so that pages have their height when it scrolls.
  useLayoutEffect(() => {
    if (!body) return;
    const fit = () => {
      const style = getComputedStyle(body);
      const inside = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      body.style.setProperty('--page-height', `${Math.max(0, inside)}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(body);
    return () => observer.disconnect();
  }, [body]);

  useLayoutEffect(() => {
    if (!showRef.current || !body) return;
    showRef.current = false;
    const pages = body.querySelectorAll<HTMLElement>('.qa-page');
    const newest = pages[pages.length - 1];
    if (!newest) return;
    if (getComputedStyle(body).maxHeight === 'none') {
      newest.scrollIntoView({ block: 'start' }); // narrow screens: the panel grows, the page scrolls
      return;
    }
    const gap = parseFloat(getComputedStyle(body).paddingTop);
    body.scrollTop += newest.getBoundingClientRect().top - body.getBoundingClientRect().top - gap;
  }, [body, messages]);

  const showNewest = useCallback(() => {
    showRef.current = true;
  }, []);

  return { bodyRef: setBody, showNewest };
}
