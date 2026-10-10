const isoPattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;
const weekdays: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function localDate(now: Date, timeZone: string): [number, number, number] {
  const values = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => Number(values.find(item => item.type === type)?.value);
  return [part('year'), part('month'), part('day')];
}

function addDays([year, month, day]: [number, number, number], amount: number): [number, number, number] {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function formatDate([year, month, day]: [number, number, number]) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validIso(value: string): boolean {
  if (!isoPattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day);
}

/** Return a normalized ISO date or preserved ISO timestamp; undefined means invalid input. */
export function parseDeadline(value: string, now = new Date(), timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone): string | undefined {
  const input = value.trim();
  if (validIso(input)) return input;
  const today = localDate(now, timeZone);
  const normalized = input.toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'today') return formatDate(today);
  if (normalized === 'tomorrow') return formatDate(addDays(today, 1));
  const duration = /^(\d)\s*([dw])$/.exec(normalized);
  if (duration) {
    const amount = Number(duration[1]);
    if (duration[2] === 'd' && amount >= 1 && amount <= 9) return formatDate(addDays(today, amount));
    if (duration[2] === 'w' && amount >= 1 && amount <= 4) return formatDate(addDays(today, amount * 7));
    return undefined;
  }
  const weekday = /^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(normalized);
  if (weekday) {
    const currentDay = new Date(Date.UTC(today[0], today[1] - 1, today[2])).getUTCDay();
    const offset = (weekdays[weekday[1]] - currentDay + 7) % 7 || 7;
    return formatDate(addDays(today, offset));
  }
  return undefined;
}
