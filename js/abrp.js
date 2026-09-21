// ABRP's "Export to Excel" file. No dependency: an .xlsx is a zip of XML, the
// browser can inflate with DecompressionStream, and ABRP writes every cell as
// an inline string or a plain number, so no shared-strings table is needed.
//
// The sheet looks like:
//   A1  "ABRP Plan"
//   A2  plan URL
//   A4  header: Waypoint | Arrival SoC | Depart SoC | Cost | Charge Card |
//               Charge duration | Distance | Drive duration | Arrival | Departure
//   A5.. one row per stop; "Drive duration" is the drive FROM this stop to the
//        next one; the last stop has none
//   final row: totals, whose Waypoint cell is the total trip time
//
// It carries no coordinates. Stops come back as names to geocode.

// ------------------------------------------------------------------ zip

const textDecoder = new TextDecoder();

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }

// Read one entry by walking local file headers (enough for these small files).
export async function readZipEntry(buffer, wantedName) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let o = 0;
  while (o + 30 <= bytes.length && u32(dv, o) === 0x04034b50) {
    const method = u16(dv, o + 8);
    const compSize = u32(dv, o + 18);
    const nameLen = u16(dv, o + 26);
    const extraLen = u16(dv, o + 28);
    const name = textDecoder.decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const dataStart = o + 30 + nameLen + extraLen;
    if (name === wantedName) {
      const data = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) return textDecoder.decode(data);
      if (method !== 8) throw new Error(`Unsupported zip method ${method}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    }
    o = dataStart + compSize;
  }
  throw new Error(`${wantedName} not found in the file`);
}

// ------------------------------------------------------------------ sheet

function colOf(ref) { return ref.replace(/\d+/g, ""); }

function unescapeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    if (e === "amp") return "&"; if (e === "lt") return "<"; if (e === "gt") return ">";
    if (e === "quot") return '"'; if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

// Returns rows as { COL: value } objects in sheet order. A deliberately small
// reader: SpreadsheetML from ABRP is flat, and this needs no DOMParser so the
// same code runs in the browser and in the Node tests.
export function parseSheetRows(xml) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (/\br="([A-Z]+)\d+"/.exec(cell[1]) || [])[1];
      if (!ref) continue;
      const body = cell[2] || "";
      let value = "";
      const is = /<is>([\s\S]*?)<\/is>/.exec(body);
      if (is) value = Array.from(is[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)).map((t) => t[1]).join("");
      else { const v = /<v>([\s\S]*?)<\/v>/.exec(body); if (v) value = v[1]; }
      cells[ref] = unescapeXml(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

// "1 h 7 min", "36 min", "5 min", "2 h" -> seconds; null if not a duration.
export function parseAbrpDuration(text) {
  const s = (text || "").trim().toLowerCase();
  if (!s) return null;
  let m, total = 0, matched = false;
  if ((m = /(\d+)\s*h\b/.exec(s))) { total += +m[1] * 3600; matched = true; }
  if ((m = /(\d+)\s*min\b/.exec(s))) { total += +m[1] * 60; matched = true; }
  return matched ? total : null;
}

// "4:09 PM" -> minutes since midnight; null if not a clock time.
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec((text || "").trim());
  if (!m) return null;
  let h = +m[1];
  const ampm = (m[3] || "").toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + +m[2];
}

// ABRP names a start or end that has no address "Home", "Point on map",
// "Current location" and the like. Those can't be geocoded.
export function isUnresolvableName(name) {
  return /^(home|work|point on map|current location|my location|dropped pin)$/i.test((name || "").trim());
}

// "Tesla Supercharger [Saini Charge] Sandy, UT [Tesla]" -> "Tesla Supercharger Sandy, UT"
// "Tesla Supercharger Beaver, UT - 525 W [Tesla]" -> "Tesla Supercharger Beaver, UT".
// The bracketed network tag and the " - street" fragment after the state
// both send the geocoder to the wrong charger: with "525 W" left in, Photon
// matched a different Supercharger 90 miles away. The fragment is kept
// separately (stopNameDetail) to choose among a city's chargers.
const DETAIL_RE = /(,\s*[A-Z]{2})\s+-\s+(.*)$/;
export function cleanStopName(name) {
  return (name || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(DETAIL_RE, "$1")
    .replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}
export function stopNameDetail(name) {
  const m = DETAIL_RE.exec((name || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " "));
  return m ? m[2].trim() || null : null;
}

/**
 * @returns {{ planUrl: string|null,
 *             stops: [{ name, rawName, detail, chargeSeconds, driveSecondsToNext, arrivalMin, departureMin }],
 *             totalDriveSeconds, totalSeconds }}
 */
export function parseAbrpRows(rows) {
  const headerIdx = rows.findIndex((r) => /^waypoint$/i.test(r.A || ""));
  if (headerIdx < 0) throw new Error("This doesn't look like an ABRP export (no Waypoint header).");
  const header = rows[headerIdx];
  const col = {};
  for (const [c, label] of Object.entries(header)) col[label.toLowerCase()] = c;
  const need = (label) => col[label] || null;
  const cName = need("waypoint"), cCharge = need("charge duration"), cDrive = need("drive duration");
  const cArr = need("arrival"), cDep = need("departure");

  const planUrl = (rows.find((r) => /plan_uuid=/.test(r.A || "")) || {}).A || null;
  const stops = [];
  let totals = null;
  for (const r of rows.slice(headerIdx + 1)) {
    const a = r.A || "";
    if (!a) continue;
    if (parseAbrpDuration(a) !== null && !(cArr && r[cArr]) && !(cDep && r[cDep])) { totals = r; break; }
    const chargeSeconds = parseAbrpDuration(cCharge && r[cCharge]) || 0;
    const arrivalMin = parseClock(cArr && r[cArr]);
    const departureMin = parseClock(cDep && r[cDep]);
    // Time actually spent at the stop. ABRP's clock gap runs a few minutes
    // longer than "Charge duration" (plugging in, walking), and the clock is
    // what its arrival times are built from, so prefer the gap.
    let dwellSeconds = chargeSeconds;
    if (arrivalMin !== null && departureMin !== null) {
      const gap = ((departureMin - arrivalMin + 1440) % 1440) * 60;
      if (gap > 0 && gap < 12 * 3600) dwellSeconds = gap;
    }
    stops.push({
      rawName: a,
      name: cleanStopName(a),
      detail: stopNameDetail(a),
      chargeSeconds,
      dwellSeconds,
      driveSecondsToNext: parseAbrpDuration(cDrive && r[cDrive]),
      arrivalMin,
      departureMin,
    });
  }
  if (stops.length < 2) throw new Error("ABRP export has fewer than two stops.");
  const cDist = need("distance");
  return {
    planUrl,
    stops,
    totalMiles: totals && cDist ? parseMiles(totals[cDist]) : null,
    totalDriveSeconds: totals && cDrive ? parseAbrpDuration(totals[cDrive]) : null,
    totalSeconds: totals ? parseAbrpDuration(totals.A) : null,
  };
}

// "58 mi" -> 58, "0 ft" -> 0, "93 km" -> miles; null if not a distance.
export function parseMiles(text) {
  const m = /^([\d.,]+)\s*(mi|km|ft|m)\b/i.exec((text || "").trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const u = m[2].toLowerCase();
  if (u === "mi") return n;
  if (u === "km") return n / 1.609344;
  if (u === "ft") return n / 5280;
  return n / 1609.344;
}

export async function parseAbrpXlsx(buffer) {
  const xml = await readZipEntry(buffer, "xl/worksheets/sheet1.xml");
  return parseAbrpRows(parseSheetRows(xml));
}

export function looksLikeXlsx(filename, buffer) {
  if (/\.xlsx$/i.test(filename)) return true;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
