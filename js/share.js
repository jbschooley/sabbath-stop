// Shareable plans. The whole form (route, departure, filters) is encoded in
// the URL fragment as base64url JSON: "#s=<payload>". The fragment never
// reaches a server, works on a static host, and survives copy-paste in chat.

export const SHARE_VERSION = 1;

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Keep only what the form needs; drop nulls so the link stays short.
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === "" || v === false) continue;
      out[k] = compact(v);
    }
    return out;
  }
  if (typeof value === "number") return Math.round(value * 1e5) / 1e5;
  return value;
}

export function encodeShare(plan) {
  return toBase64Url(JSON.stringify(compact({ v: SHARE_VERSION, ...plan })));
}

export function decodeShare(payload) {
  const obj = JSON.parse(fromBase64Url(payload));
  if (!obj || typeof obj !== "object" || obj.v !== SHARE_VERSION) throw new Error("Unrecognised share link");
  return obj;
}

// Extract the payload from a URL's fragment, or null.
export function sharePayloadFrom(hash) {
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash || "");
  return m ? m[1] : null;
}

export function shareUrl(base, plan) {
  return `${base}#s=${encodeShare(plan)}`;
}
