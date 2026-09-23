// Relative + absolute time formatting for comments and chat (Intl, zero deps).

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

// Intl formatters are expensive to CREATE (locale lookup + rules), not to use;
// `toLocaleTimeString(…)` builds one per call. The chat feed calls these per message per render —
// hundreds of constructions per keystroke. One instance per format, built once.
const CLOCK_FMT = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const DATE_FMT = new Intl.DateTimeFormat();
const WEEKDAY_FMT = new Intl.DateTimeFormat([], { weekday: 'long' });
const MONTH_DAY_FMT = new Intl.DateTimeFormat([], { month: 'long', day: 'numeric' });
const MONTH_DAY_YEAR_FMT = new Intl.DateTimeFormat([], {
  month: 'long', day: 'numeric', year: 'numeric',
});

// Date parsing is the chat feed's most frequent operation (grouping, day dividers, first-unread,
// per-row clocks hit the same strings repeatedly per rebuild); `new Date(str.replace(...))`
// allocates each time — thousands per frame on a 500-message window. `created` is immutable, so
// memoize. Bounded cache cleared wholesale: the feed lives within WINDOW_MAX.
const MS_CACHE = new Map<string, number>();
const MS_CACHE_MAX = 4000;

// PocketBase serializes dates as "YYYY-MM-DD HH:mm:ss.SSSZ" (space, not T). Returns epoch ms,
// memoized by raw string.
export function pbDateMs(dateStr: string): number {
  const hit = MS_CACHE.get(dateStr);
  if (hit !== undefined) return hit;
  const ms = new Date(dateStr.replace(' ', 'T')).getTime();
  if (MS_CACHE.size >= MS_CACHE_MAX) MS_CACHE.clear();
  MS_CACHE.set(dateStr, ms);
  return ms;
}

function parsePbDate(dateStr: string): Date {
  return new Date(pbDateMs(dateStr));
}

// Local midnight key: cheaper "same day" check than toDateString (builds a string per call).
function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function relativeTime(dateStr: string): string {
  const date = parsePbDate(dateStr);
  let duration = (date.getTime() - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'years');
}

export function absoluteTime(dateStr: string): string {
  return parsePbDate(dateStr).toLocaleString();
}

// Bare clock "7:31 PM" for the chat gutter (the day is clear from context).
export function clockTime(dateStr: string): string {
  return CLOCK_FMT.format(parsePbDate(dateStr));
}

// "Today at 8:21 PM", "Yesterday at …", then a plain date. A full timestamp per line reads like a
// log.
export function chatTime(dateStr: string): string {
  const date = parsePbDate(dateStr);
  const clock = CLOCK_FMT.format(date);
  const days = Math.round((dayStart(Date.now()) - dayStart(date.getTime())) / 86400000);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  return `${DATE_FMT.format(date)} ${clock}`;
}

// Day separator heading: "Today", "Yesterday", weekday within a week, then a date — so each line
// can show a bare clock.
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

export function sameDay(a: string, b: string): boolean {
  return dayStart(pbDateMs(a)) === dayStart(pbDateMs(b));
}

// Edited meaningfully after creation (>2s drift).
export function wasEdited(created: string, updated: string): boolean {
  return parsePbDate(updated).getTime() - parsePbDate(created).getTime() > 2000;
}
