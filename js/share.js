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
  const flag = payload[0];
  const bytes = b64urlToBytes(payload.slice(1));
  const raw = flag === 'g'
    ? await pipe(new DecompressionStream('gzip'), bytes)
    : bytes;
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
