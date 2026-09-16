// Signed, tamper-proof, time-bound tokens for gate QR codes.
//
// A QR code is only as secure as what it encodes. If it just encoded a
// pass ID, anyone could screenshot someone else's QR, or hand-write a
// fake one. Instead each QR encodes a short signed token: passId + an
// expiry + a server-side secret HMAC. The gate-verify endpoint recomputes
// the HMAC and rejects anything that doesn't match or has expired --
// so the *server clock and secret* decide validity, never the phone
// showing the code.

const crypto = require('crypto');

const SECRET = process.env.GATEPASS_SECRET || 'dev-only-change-this-secret';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

/**
 * @param {string} passId
 * @param {number} expiresAtMs - unix ms after which the token is invalid
 * @param {string} nonce - unique per issuance, so re-issuing a QR for the
 *   same pass (e.g. member reopened the app) still yields a fresh token,
 *   without changing what "used" means server-side (that's tracked by passId).
 */
function sign(passId, expiresAtMs, nonce) {
  const payload = `${passId}.${expiresAtMs}.${nonce}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest();
  return base64url(Buffer.from(payload)) + '.' + base64url(sig).slice(0, 16);
}

/**
 * @returns {{ok:true, passId, expiresAtMs} | {ok:false, reason:string}}
 */
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigShort] = parts;
  let payload;
  try {
    payload = fromBase64url(payloadB64).toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expectedSig = base64url(
    crypto.createHmac('sha256', SECRET).update(payload).digest()
  ).slice(0, 16);

  const a = Buffer.from(sigShort);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const [passId, expStr] = payload.split('.');
  const expiresAtMs = Number(expStr);
  if (!passId || !Number.isFinite(expiresAtMs)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true, passId, expiresAtMs };
}

module.exports = { sign, verify };
