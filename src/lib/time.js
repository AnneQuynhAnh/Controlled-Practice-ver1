// Calendar helpers. Vietnam (Asia/Ho_Chi_Minh) observes no DST, so the offset is a constant +07:00.
export const TIMEZONE = 'Asia/Ho_Chi_Minh';
const OFFSET = '+07:00';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD of the instant in the plan timezone. */
export function localDate(ms) {
  return dateFmt.format(new Date(ms));
}

/** Epoch ms of 00:00 on dateStr in the plan timezone. */
export function dayStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`Invalid date: ${dateStr}`);
  const ms = Date.parse(`${dateStr}T00:00:00${OFFSET}`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${dateStr}`);
  return ms;
}

export function addDays(dateStr, n) {
  return localDate(dayStart(dateStr) + n * DAY + HOUR);
}

export function systemClock() {
  return { now: () => Date.now() };
}

/** Mutable clock for tests. */
export function fakeClock(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}
