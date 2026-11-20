// Spotify now-playing via Authorization Code + PKCE (no server needed).
// The Web API gives us track info and playback position, but not audio.

const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const LS = window.localStorage;
// A request on flaky Wi-Fi (or after sleep) can hang forever and stop polling / loop seeks: give up after a while.
function timeout(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
}
// fetch that says something readable when it gives up
async function fetchT(url, opts, ms) {
  try { return await fetch(url, { ...opts, signal: timeout(ms) }); } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('Spotify is slow to answer; trying again…');
    throw e;
  }
}

function redirectUri() {
  return location.origin + location.pathname;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getClientId() { return LS.getItem('sp_client_id') || ''; }
export function setClientId(id) { LS.setItem('sp_client_id', id.trim()); }
export function isLoggedIn() { return !!LS.getItem('sp_refresh'); }
export function logout() { ['sp_access', 'sp_refresh', 'sp_expires'].forEach((k) => LS.removeItem(k)); }

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Enter your Spotify Client ID first');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  LS.setItem('sp_verifier', verifier);
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

async function tokenRequest(params) {
  const r = await fetchT('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...params }),
  }, 10000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // a refresh token Spotify won't take any more (access removed, expired): log out, don't retry every poll
    if (params.grant_type === 'refresh_token' && r.status === 400) {
      // another window of the app refreshed first (the old refresh token is then used up): use its new tokens
      if (LS.getItem('sp_refresh') && LS.getItem('sp_refresh') !== params.refresh_token) return;
      logout(); throw loggedOutError();
    }
    throw new Error(j.error_description || j.error || 'token error');
  }
  LS.setItem('sp_access', j.access_token);
  LS.setItem('sp_expires', String(Date.now() + (j.expires_in - 60) * 1000));
  if (j.refresh_token) LS.setItem('sp_refresh', j.refresh_token);
}

// Call once on page load: finishes the redirect if we just came back from Spotify.
export async function handleRedirect() {
  const u = new URL(location.href);
  const code = u.searchParams.get('code');
  if (!code) return false;
  history.replaceState(null, '', redirectUri());
  await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
    code_verifier: LS.getItem('sp_verifier') || '',
  });
  return true;
}

function loggedOutError() {
  const e = new Error('Spotify login expired: click Connect Spotify again.');
  e.loggedOut = true;
  return e;
}

// One refresh at a time: a poll and a seek (Loop line) both finding the token expired must not both use the
// refresh token (Spotify may replace it, and the second request would then fail).
let refreshing = null;
async function accessToken() {
  if (Date.now() > Number(LS.getItem('sp_expires') || 0)) {
    if (!LS.getItem('sp_refresh')) throw loggedOutError();
    refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: LS.getItem('sp_refresh') })
      .finally(() => { refreshing = null; });
    await refreshing;
  }
  return LS.getItem('sp_access');
}

// Returns { id, name, artist, album, durationMs, isPlaying, progressMs, at } or null.
// `at` is the performance.now() moment progressMs refers to (midpoint of the request).
export async function nowPlaying(retried = false) {
  const tok = await accessToken();
  const t0 = performance.now();
  const r = await fetchT('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: 'Bearer ' + tok },
  }, 5000);
  const t1 = performance.now();
  if (r.status === 204) return null;
  if (r.status === 401) {
    // token expired early (or was revoked): refresh and ask again, rather than reporting
    // "nothing playing", which would look like the song stopped
    LS.setItem('sp_expires', '0');
    if (!retried) return nowPlaying(true);
    throw new Error('Spotify login expired: click Disconnect, then Connect Spotify again.');
  }
  if (r.status === 429) {
    const e = new Error('Spotify asked us to slow down; trying again shortly.');
    e.retryAfterMs = Math.min(60, Math.max(2, +r.headers.get('Retry-After') || 5)) * 1000;
    throw e;
  }
  if (!r.ok) throw new Error('Spotify ' + r.status);
  const j = await r.json();
  if (!j.item) return null;
  return {
    // local files have no id (null): use their uri, so two local songs aren't "the same song"
    id: j.item.id || j.item.uri || ('local:' + j.item.name + '|' + (j.item.artists || []).map((a) => a.name).join(', ')),
    name: j.item.name,
    artist: j.item.artists.map((a) => a.name).join(', '),
    firstArtist: j.item.artists[0] && j.item.artists[0].name,
    album: j.item.album && j.item.album.name,
    art: j.item.album && j.item.album.images && j.item.album.images[0] && j.item.album.images[0].url,
    durationMs: j.item.duration_ms,
    isPlaying: j.is_playing,
    progressMs: j.progress_ms,
    at: (t0 + t1) / 2,
  };
}

// Jump playback to `ms` (needs Premium + the modify scope; reconnect if you logged in before it was added).
export async function seek(ms) {
  const tok = await accessToken();
  const r = await fetchT('https://api.spotify.com/v1/me/player/seek?position_ms=' + Math.max(0, Math.round(ms)), {
    method: 'PUT', headers: { Authorization: 'Bearer ' + tok },
  }, 5000);
  if (r.status === 401 || r.status === 403) throw new Error('Spotify refused the seek: click Disconnect, then Connect Spotify again to allow playback control (Premium only).');
  if (!r.ok) throw new Error('Spotify seek failed (' + r.status + ')');
}
