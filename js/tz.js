// Timezone math with nothing but Intl. Every comparison against a meeting
// time happens in the *building's* zone, never the user's.

const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Wall-clock parts of an instant in tz.
export function localParts(date, tz) {
  const parts = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) {
    if (type !== "literal") parts[type] = parseInt(value, 10);
  }
  return { y: parts.year, m: parts.month, d: parts.day, hh: parts.hour % 24, mm: parts.minute, ss: parts.second };
}

// Offset of tz from UTC at the given instant, in minutes.
export function tzOffsetMinutes(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// The instant at which the wall clock in tz reads y-m-d hh:mm. Two rounds of
// offset correction handle DST edges well enough for meeting times.
export function zonedToInstant(y, m, d, hh, mm, tz) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(new Date(guess), tz);
    guess = Date.UTC(y, m - 1, d, hh, mm) - off * 60000;
  }
  return new Date(guess);
}

// Meeting start ("HH:MM") on the calendar day that `arrival` falls on in tz.
export function meetingStartInstant(arrival, startHHMM, tz) {
  const [hh, mm] = startHHMM.split(":").map(Number);
  const p = localParts(arrival, tz);
  return zonedToInstant(p.y, p.m, p.d, hh, mm, tz);
}

export function tzAbbrev(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(date);
  return (parts.find((p) => p.type === "timeZoneName") || {}).value || tz;
}

export function fmtTime(date, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

export function fmtHHMM(hhmm, tz, onDate) {
  // Render a "HH:MM" wall time as e.g. "1:00 PM MT" using a real instant so
  // the zone abbreviation is right for the season.
  const inst = meetingStartInstant(onDate, hhmm, tz);
  return `${fmtTime(inst, tz)} ${tzAbbrev(inst, tz)}`;
}

export function fmtDateTime(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

// Default departure as a value for <input type=datetime-local>: on a Sunday,
// now rounded up to the next five minutes (you're probably already driving);
// any other day, 8:00 AM next Sunday.
export function defaultDepartureLocal(now = new Date()) {
  const d = new Date(now);
  if (d.getDay() === 0) {
    d.setSeconds(0, 0);
    const extra = (5 - (d.getMinutes() % 5)) % 5;
    d.setMinutes(d.getMinutes() + extra);
    return toDatetimeLocal(d);
  }
  d.setDate(d.getDate() + (7 - d.getDay()));
  d.setHours(8, 0, 0, 0);
  return toDatetimeLocal(d);
}

export function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
