// Relative + absolute time formatting for comments.
// Uses the built-in Intl.RelativeTimeFormat — zero dependencies.

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

// Intl formatters are expensive to CREATE (locale lookup + rule assembly), not
// to use — and `toLocaleTimeString(…)` builds a fresh one on every call. The
// chat feed calls these once per message per render, so a few hundred messages
// meant a few hundred formatter constructions per keystroke. One instance per
// format, built once, reused forever.
const CLOCK_FMT = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const DATE_FMT = new Intl.DateTimeFormat();
const WEEKDAY_FMT = new Intl.DateTimeFormat([], { weekday: 'long' });
const MONTH_DAY_FMT = new Intl.DateTimeFormat([], { month: 'long', day: 'numeric' });
const MONTH_DAY_YEAR_FMT = new Intl.DateTimeFormat([], {
  month: 'long', day: 'numeric', year: 'numeric',
});

/** PocketBase serialises dates as "YYYY-MM-DD HH:mm:ss.SSSZ" (space, not T). */
function parsePbDate(dateStr: string): Date {
  return new Date(dateStr.replace(' ', 'T'));
}

/** e.g. "3 hours ago", "yesterday", "in 2 minutes". */
export function relativeTime(dateStr: string): string {
  const date = parsePbDate(dateStr);
  let duration = (date.getTime() - Date.now()) / 1000; // seconds; negative = past
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'years');
}

/** Full local timestamp for tooltips. */
export function absoluteTime(dateStr: string): string {
  return parsePbDate(dateStr).toLocaleString();
}

/** Just the clock: "7:31 PM". Used in the chat gutter, where the day is already
 *  obvious from the message above and only the minute matters. */
export function clockTime(dateStr: string): string {
  return CLOCK_FMT.format(parsePbDate(dateStr));
}

/** Chat-style stamp: "Today at 8:21 PM", "Yesterday at 11:40 PM", and a plain
 *  date once the message is older than that. A full local timestamp on every
 *  line reads like a log; in a chat the day is the only thing worth spelling out. */
export function chatTime(dateStr: string): string {
  const date = parsePbDate(dateStr);
  const clock = CLOCK_FMT.format(date);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  return `${DATE_FMT.format(date)} ${clock}`;
}

/** Heading for the day separator in the chat feed: "Today", "Yesterday",
 *  "Friday" within the last week, then a plain date. The separator carries the
 *  day, so the stamp on each line can stay a bare clock. */
export function dayLabel(dateStr: string): string {
  const date = parsePbDate(dateStr);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAY_FMT.format(date);
  return (date.getFullYear() === today.getFullYear() ? MONTH_DAY_FMT : MONTH_DAY_YEAR_FMT)
    .format(date);
}

/** Two timestamps on the same local calendar day? */
export function sameDay(a: string, b: string): boolean {
  return parsePbDate(a).toDateString() === parsePbDate(b).toDateString();
}

/** True if the record was edited meaningfully after creation (>2s drift). */
export function wasEdited(created: string, updated: string): boolean {
  return parsePbDate(updated).getTime() - parsePbDate(created).getTime() > 2000;
}
