// A deliberately tiny router -- this project has zero npm dependencies
// (see README for why), so instead of Express this is ~50 lines that do
// just enough: method + path-with-:params matching, JSON body parsing,
// and small response helpers.

const { URL } = require('url');

function compile(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + regexStr + '$'), paramNames };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method, ...compile(pattern), handler });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => (params[name] = m[i + 1]));
      const ctx = { req, res, params, query: url.searchParams, cookies: parseCookies(req.headers.cookie) };

      if (req.method === 'POST') {
        ctx.body = await readBody(req);
      }

      try {
        await route.handler(ctx);
      } catch (err) {
        console.error('Route error:', err);
        sendJson(res, 500, { ok: false, error: 'internal_error' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  return { get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), handle };
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB -- generous for a form + a small base64 logo image

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let overLimit = false;
    req.on('data', (chunk) => {
      if (overLimit) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        overLimit = true;
        req.destroy();
        return resolve({});
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) return; // already resolved above
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = req.headers['content-type'] || '';
      if (!raw) return resolve({});
      try {
        if (contentType.includes('application/json')) {
          resolve(JSON.parse(raw));
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        } else {
          resolve({ _raw: raw });
        }
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

// A minimal, dependency-free Set-Cookie writer -- good enough for the one
// thing this project needs it for (marking a browser as an
// organiser-activated gate-scanning device). maxAgeDays defaults to a long
// window since a scanner device is activated once and expected to stay
// activated.
function setCookie(res, name, value, maxAgeDays) {
  const maxAge = Math.round((maxAgeDays || 365) * 86400);
  const cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  const next = existing ? (Array.isArray(existing) ? existing.concat(cookie) : [existing, cookie]) : cookie;
  res.setHeader('Set-Cookie', next);
}

module.exports = { createRouter, sendJson, sendHtml, parseCookies, setCookie };
