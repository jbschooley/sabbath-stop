// Geometry helpers. Pure functions, no DOM, no network.

export const EARTH_MI = 3958.7613;

export function haversineMi(lng1, lat1, lng2, lat2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(h));
}

// Valhalla and OSRM (with geometries=polyline6) encode at precision 6.
// Decoding at 5 puts you in the wrong hemisphere. Returns [[lng, lat], ...].
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 0, shift = 0, byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

// Must match build_tiles.py: floor of the SW corner, w/e and n/s prefixes.
export function tileKey(lng, lat) {
  const x = Math.floor(lng);
  const y = Math.floor(lat);
  return `${x < 0 ? "w" : "e"}${Math.abs(x)}_${y < 0 ? "s" : "n"}${Math.abs(y)}`;
}

export function tilesForBbox([minLng, minLat, maxLng, maxLat]) {
  const keys = [];
  for (let x = Math.floor(minLng); x <= Math.floor(maxLng); x++) {
    for (let y = Math.floor(minLat); y <= Math.floor(maxLat); y++) {
      keys.push(tileKey(x, y));
    }
  }
  return keys;
}

export function bboxOf(points) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

export function bufferBbox([minLng, minLat, maxLng, maxLat], miles) {
  const dLat = miles / 69;
  const midLat = (minLat + maxLat) / 2;
  const dLng = miles / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [minLng - dLng, minLat - dLat, maxLng + dLng, maxLat + dLat];
}

// Cheap spatial index over route vertices so the coarse proximity pass is a
// neighbourhood lookup, not a scan of every vertex per building.
export class VertexBuckets {
  constructor(points, cellDeg = 0.25) {
    this.cellDeg = cellDeg;
    this.cells = new Map();
    points.forEach((p, i) => {
      const k = this.key(p.lng, p.lat);
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(i);
    });
    this.points = points;
  }
  key(lng, lat) {
    return `${Math.floor(lng / this.cellDeg)},${Math.floor(lat / this.cellDeg)}`;
  }
  // Nearest vertex index within radiusMi, or -1.
  nearest(lng, lat, radiusMi) {
    const rDeg = radiusMi / 69;
    const span = Math.ceil(rDeg / this.cellDeg) + 1;
    const cx = Math.floor(lng / this.cellDeg);
    const cy = Math.floor(lat / this.cellDeg);
    let best = -1, bestMi = radiusMi;
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) {
        const arr = this.cells.get(`${x},${y}`);
        if (!arr) continue;
        for (const i of arr) {
          const p = this.points[i];
          const mi = haversineMi(lng, lat, p.lng, p.lat);
          if (mi <= bestMi) { bestMi = mi; best = i; }
        }
      }
    }
    return { index: best, miles: bestMi };
  }
}
