/** SQLite's CURRENT_TIMESTAMP, as the backend sends it: UTC, written "2026-11-07 08:16:22". */
export function parseTimestamp(value: string) {
  return new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

export const DATE_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'] as const;
export type DateGroup = (typeof DATE_GROUPS)[number];

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Which group of the Interviews page something last changed at `value` goes under. */
export function dateGroup(value: string, now = new Date()): DateGroup {
  const days = Math.round((startOfDay(now) - startOfDay(parseTimestamp(value))) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days < 7 ? 'Previous 7 days' : 'Earlier';
}

/** "Just now", "5 min ago", "3 hours ago", "Yesterday", "Monday", or a date like "Nov 2". */
export function friendlyTime(value: string, now = new Date()) {
  const date = parseTimestamp(value);
  const group = dateGroup(value, now);
  if (group === 'Today') {
    const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (group === 'Yesterday') return 'Yesterday';
  if (group === 'Previous 7 days') return date.toLocaleDateString(undefined, { weekday: 'long' });
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year });
}
