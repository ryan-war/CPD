// Shareable links: a whole project encoded into a URL, no server, no library.
//
// Save JSON hands someone a file to import. A link is lighter — paste it and
// the plan opens. The project is JSON, so it is gzipped in the browser with the
// native CompressionStream (no dependency) and base64url'd into the URL hash;
// where CompressionStream is missing the bytes go in raw. A one-character flag
// leads the payload so the reader knows which it was given.
//
// The hash, not the query string, carries it: fragments are never sent to a
// server, so the plan stays on the two machines that share the link.

// Past this the URL is longer than browsers and chat apps reliably carry, and a
// truncated link is worse than none. The caller warns and points at Save JSON.
export const MAX_LINK_LENGTH = 16000;

// A shared link is untrusted input: anyone can craft one. Two caps stop a
// hostile payload from exhausting memory — one on the encoded bytes before we
// touch them, one on the *decompressed* size, checked as it inflates rather
// than after, so a small "zip bomb" cannot balloon first and be rejected later.
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;   // encoded, ~5.3M chars of base64
const MAX_INFLATED_BYTES = 12 * 1024 * 1024; // a genuinely large project fits

function bytesToB64url(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipe(stream, bytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Decompress with a running size cap. Reading the stream chunk by chunk means
 * the limit is enforced *as* it inflates — the decoder is cancelled the moment
 * the output would exceed the cap, rather than after a bomb has already
 * expanded in memory.
 */
async function inflateCapped(stream, bytes, limit) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('shared project is too large');
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Encode a project to a compact URL-safe payload string. */
export async function encodeProject(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  if (typeof CompressionStream !== 'undefined') {
    const gz = await pipe(new CompressionStream('gzip'), bytes);
    return 'g' + bytesToB64url(gz);
  }
  return 'r' + bytesToB64url(bytes);
}

/** Decode a payload string back into a raw (un-normalised) project object. */
export async function decodeProject(payload) {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error('shared project is too large');
  }
  const flag = payload[0];
  const bytes = b64urlToBytes(payload.slice(1));
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('shared project is too large');
  }
  let raw;
  if (flag === 'g') {
    raw = await inflateCapped(new DecompressionStream('gzip'), bytes, MAX_INFLATED_BYTES);
  } else {
    if (bytes.length > MAX_INFLATED_BYTES) throw new Error('shared project is too large');
    raw = bytes;
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

/** The full shareable URL for a project, pointing at this page's own address. */
export async function buildShareLink(state) {
  const payload = await encodeProject(state);
  return `${location.origin}${location.pathname}#p=${payload}`;
}

/** The shared payload in the current URL, or null when there is none. */
export function sharedPayloadInUrl() {
  const match = (location.hash || '').match(/^#p=(.+)$/);
  return match ? match[1] : null;
}
