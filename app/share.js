// A drawing in a link: #state=<base64url of the JSON> (docs/design/app.md, D8).

export function encodeState(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// The state in a location hash, or null if it has none.
export function stateFromHash(hash) {
  const match = /(?:^#|&)state=([A-Za-z0-9_-]+)/.exec(hash);
  return match ? decodeState(match[1]) : null;
}

// A tab named in a link, #tab=<name>, opens the page's own example on that
// tab: the README's screenshots link to their tabs this way. The names are
// the tabs' as the page shows them; the tab ids work too.
export const TAB_NAMES = {
  "draw-speech": "tracks",
  "draw-spectrogram": "painted",
  "erase-spectrogram": "mask",
  "draw-modulation": "blobs",
  "erase-modulation": "edit",
  "draw-path": "paths",
};

// The tab id a location hash names, or null if it names none.
export function tabFromHash(hash) {
  const match = /(?:^#|&)tab=([a-z-]+)/.exec(hash);
  if (!match) return null;
  const name = match[1];
  return TAB_NAMES[name] ?? (Object.values(TAB_NAMES).includes(name) ? name : null);
}
