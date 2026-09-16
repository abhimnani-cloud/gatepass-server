const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, uid } = require('./lib/db');
const { computeState } = require('./lib/state');
const { sign, verify } = require('./lib/token');
const { encodeToSvgDataUri } = require('./lib/qr');
const { generateOtp, sendOtp, sendMessage } = require('./lib/notify');
const { createRouter, sendJson, sendHtml, setCookie } = require('./lib/router');
const { pageShell, verifyResultPage, staffPage, adminPage, adminLoginPage, claimPage, allotPage, requestPage } = require('./lib/pages');
const EVENT_CONFIG = require('./lib/event.config');

// Unlike the rest of event.config.js (which only matters at first seed),
// this one is read fresh on every request -- so it can be flipped at any
// time, even with real members/coupons already in the system, just by
// editing the file and restarting the server. It only changes what's
// *shown*, never touches stored data.
function luckyDrawEnabled() {
  return EVENT_CONFIG.LUCKY_DRAW_ENABLED !== false;
}

const PORT = process.env.PORT || 4000;
// RENDER_EXTERNAL_URL is auto-injected by Render on every web service --
// no need to hand-copy the live URL into an env var after each deploy.
// BASE_URL still wins if someone sets it explicitly (e.g. a custom domain).
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
// Same override pattern as DATA_DIR/BASE_URL -- an ADMIN_PASSWORD env var on
// a live host wins over the one in event.config.js, so the real password
// never has to be committed to the repo.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || EVENT_CONFIG.ADMIN_PASSWORD || 'changeme123';
const router = createRouter();

// ---------- admin login gate ----------
// Everything under /admin (the organiser control panel) requires this --
// without it, anyone who finds the URL on a live deployment would have
// full control (add/remove sponsors, publish, reveal the lucky draw,
// bulk-create members, etc). /staff and /verify/:token are a separate,
// already-gated flow (per-device activation link, see isScannerDeviceAuthorized
// below) and deliberately don't need this same login.
const ADMIN_COOKIE = 'gatepass_admin';

function isAdminAuthorized(ctx) {
  const token = ctx.cookies && ctx.cookies[ADMIN_COOKIE];
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM admin_sessions WHERE token = ?').get(token);
}

// Wrap any /admin* route handler with this so a logged-out visitor gets
// bounced to the login form instead of the real page/action running.
function requireAdmin(handler) {
  return (ctx) => {
    if (!isAdminAuthorized(ctx)) {
      if (ctx.req.method === 'GET') {
        ctx.res.writeHead(302, { Location: '/admin/login' });
        return ctx.res.end();
      }
      return sendJson(ctx.res, 401, { ok: false, error: 'not_logged_in' });
    }
    return handler(ctx);
  };
}

// Every /admin* route defined below (there are ~19 of them: publish,
// sponsors, members, allotters, the lucky reveal, the emergency gate
// override, etc.) is auto-wrapped with requireAdmin the moment it's
// registered -- so a route can never slip through unguarded just because
// someone forgot to wrap it by hand. Only the login form itself (and
// logging out) stay public.
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/admin/logout']);
['get', 'post'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (pattern, handler) => {
    if (pattern.startsWith('/admin') && !PUBLIC_ADMIN_PATHS.has(pattern)) {
      return original(pattern, requireAdmin(handler));
    }
    return original(pattern, handler);
  };
});

router.get('/admin/login', (ctx) => sendHtml(ctx.res, 200, adminLoginPage(ctx.query.get('error') === '1')));
router.post('/admin/login', (ctx) => {
  const password = (ctx.body.password || '').trim();
  if (password !== ADMIN_PASSWORD) {
    ctx.res.writeHead(302, { Location: '/admin/login?error=1' });
    return ctx.res.end();
  }
  const token = uid('adm');
  db.prepare('INSERT INTO admin_sessions (token, created_at) VALUES (?,?)').run(token, Date.now());
  setCookie(ctx.res, ADMIN_COOKIE, token, 30);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});
router.post('/admin/logout', (ctx) => {
  const token = ctx.cookies && ctx.cookies[ADMIN_COOKIE];
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  setCookie(ctx.res, ADMIN_COOKIE, '', -1);
  ctx.res.writeHead(302, { Location: '/admin/login' });
  ctx.res.end();
});

// ---------- helpers ----------
function getPassWithType(passId) {
  const mp = db.prepare('SELECT * FROM member_passes WHERE id = ?').get(passId);
  if (!mp) return null;
  const pt = db.prepare('SELECT * FROM pass_types WHERE id = ?').get(mp.pass_type_id);
  return { memberPass: mp, passType: pt };
}

function serializePass(mp, pt, now) {
  return {
    id: mp.id,
    title: pt.title,
    description: pt.description,
    category: pt.category,
    icon: pt.icon || '🎟️',
    isAllDays: !!pt.is_all_days,
    windowStart: pt.window_start,
    windowEnd: pt.window_end,
    activatesAt: pt.window_start - pt.activate_lead_minutes * 60000,
    state: computeState(mp, pt, now),
    usedAt: mp.used_at,
    transfersUsed: mp.transfer_count,
    transferLimit: pt.transfer_limit,
  };
}

function serializeSponsor(s) {
  return {
    id: s.id,
    name: s.name,
    tier: s.tier,
    tagline: s.tagline || null,
    websiteUrl: s.website_url || null,
    contactUrl: s.contact_url || null,
    logoDataUri: s.logo_data_uri || null,
  };
}

// ---------- entry coupons (the only pass category admins manage now) ----------
// VIP used to be its own pass_types category; it's now a per-member flag
// (members.is_vip) instead, so "Additional benefit" extras are parked for
// now (schema still allows them, just nothing offers creating one), and the
// only pass types that exist going forward are day-specific Entry Coupons,
// auto-managed (one per day of the event) rather than hand-created.
//
// There used to also be a "combined" mode (one pass valid across every
// day). It's been removed: a combined pass is marked 'used' the moment it's
// scanned ONCE, same as any other pass here (this project has no
// per-day-reentry tracking) -- which would incorrectly lock a genuine
// multi-day holder out after their first day's entry. Day-specific coupons
// side-step that entirely (each day's coupon is independently single-use,
// which is exactly how a real multi-day wristband/ticket works), so that's
// the only option now.
const DAY_MS = 24 * 3600 * 1000;
const ENTRY_CATEGORIES = ['day1', 'day2', 'day3'];

function ensureEntryCouponPassTypes(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const existing = db.prepare(
    `SELECT * FROM pass_types WHERE event_id = ? AND category IN ('day1','day2','day3')`
  ).all(eventId);
  const byCat = {};
  existing.forEach((p) => { byCat[p.category] = p; });
  const ins = db.prepare(
    `INSERT INTO pass_types (id,event_id,title,description,category,is_all_days,window_start,window_end,activate_lead_minutes,transfer_limit,icon)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  // A rough, organiser-editable-later split of the event's total span into
  // day-length chunks -- good enough to stand up Day 1/2/3 windows without
  // needing a separate "edit event dates" admin screen yet.
  const totalDays = Math.max(1, Math.min(3, Math.ceil((event.end_at - event.start_at) / DAY_MS)));
  for (let d = 1; d <= totalDays; d++) {
    const cat = 'day' + d;
    if (byCat[cat]) continue;
    const ws = event.start_at + (d - 1) * DAY_MS;
    const we = d === totalDays ? event.end_at : event.start_at + d * DAY_MS;
    ins.run(uid('pt'), eventId, 'Day ' + d + ' Entry', 'Gate entry for day ' + d + ' of the event.', cat, 0, ws, we, 45, event.transfer_limit, '🎫');
  }
}

// If Day 1/2/3 windows already exist (created once by ensureEntryCouponPassTypes
// above, from whatever dates were set at the time), an organiser changing
// the event's dates later -- from the admin form below -- would otherwise
// leave those windows silently stale: the banner would show the new dates
// but gate entry would still open/close on the OLD ones. This reshapes any
// existing day windows onto the new span the same way they'd have been
// computed fresh. A brand-new event with no pass_types yet is unaffected --
// ensureEntryCouponPassTypes just creates them correctly the first time.
function reflowPassTypeWindows(eventId, startAt, endAt) {
  const existing = db.prepare(
    `SELECT * FROM pass_types WHERE event_id = ? AND category IN ('day1','day2','day3')`
  ).all(eventId);
  if (!existing.length) return;
  const totalDays = Math.max(1, Math.min(3, Math.ceil((endAt - startAt) / DAY_MS)));
  const upd = db.prepare('UPDATE pass_types SET window_start = ?, window_end = ? WHERE id = ?');
  existing.forEach((p) => {
    const d = Number(p.category.replace('day', ''));
    if (!d || d > totalDays) return; // shorter new span -- leave any extra day category as-is, unused
    const ws = startAt + (d - 1) * DAY_MS;
    const we = d === totalDays ? endAt : startAt + d * DAY_MS;
    upd.run(ws, we, p.id);
  });
}

// Every currently-defined Entry Coupon pass type for the event, in day
// order -- what "all days" means when allotting.
function getEntryCouponPassTypeIds(eventId, onlyCategories) {
  const cats = (onlyCategories && onlyCategories.length) ? onlyCategories : ENTRY_CATEGORIES;
  const placeholders = cats.map(() => '?').join(',');
  return db.prepare(`SELECT id FROM pass_types WHERE event_id = ? AND category IN (${placeholders}) ORDER BY category`)
    .all(eventId, ...cats).map((r) => r.id);
}

// Creates `quantity` admission units for one member. By default that's one
// of EVERY currently-active day's coupon per unit (so quantity=16 with Day
// 1 + Day 2 defined means 16 of each -- 16 people's worth of full-event
// entry). Pass `onlyCategories` (e.g. ['day2']) to allot single-day-only
// units instead -- only used when the allotter issuing them has been
// specifically permitted to do that (allotters.can_single_day).
function allotEntryCouponUnits(eventId, memberId, quantity, onlyCategories) {
  const ptIds = getEntryCouponPassTypeIds(eventId, onlyCategories);
  const ins = db.prepare(`INSERT INTO member_passes (id, pass_type_id, member_id, status) VALUES (?,?,?, 'active')`);
  for (let i = 0; i < quantity; i++) {
    ptIds.forEach((ptId) => ins.run(uid('mp'), ptId, memberId));
  }
}

// Applies a new event-wide transfer_limit retroactively to every currently
// active Entry Coupon pass type, so "how many times can this be
// re-transferred" is one rule the organiser sets once -- not something that
// could quietly end up different across pass types created at different
// times.
function applyTransferLimit(eventId, limit) {
  db.prepare('UPDATE events SET transfer_limit = ? WHERE id = ?').run(limit, eventId);
  db.prepare(`UPDATE pass_types SET transfer_limit = ? WHERE event_id = ? AND category IN ('day1','day2','day3')`).run(limit, eventId);
}

// How many currently-held entry coupons a member has, per category (day1,
// day2, day3, or the now-removed but still-possible-in-old-data 'general').
// Kept separate from the person-equivalent math below so a single transfer
// can be simulated by just decrementing one category's count.
function entryCouponCountsByCategory(memberId) {
  const rows = db.prepare(
    `SELECT pt.category as cat, COUNT(*) as c FROM member_passes mp
     JOIN pass_types pt ON pt.id = mp.pass_type_id
     WHERE mp.member_id = ? AND mp.status != 'transferred' AND pt.category IN ('day1','day2','day3','general')
     GROUP BY pt.category`
  ).all(memberId);
  const counts = {};
  rows.forEach((r) => { counts[r.cat] = r.c; });
  return counts;
}

// Every day-category currently defined for the event (e.g. ['day1','day2']
// -- could be just one, for a single-day event). This is the "every defined
// day" that person-equivalents math below needs -- NOT just whichever
// categories a given member happens to hold, otherwise someone holding only
// Day-1 coupons (e.g. from a single-day-only allotter) would incorrectly
// look like a complete admission per coupon instead of needing a matching
// Day-2 (etc.) coupon too.
function activeDayCategories(eventId) {
  return db.prepare(
    `SELECT DISTINCT category FROM pass_types WHERE event_id = ? AND category IN ('day1','day2','day3')`
  ).all(eventId).map((r) => r.category);
}

// How many complete admissions (person-equivalents) a set of per-category
// counts represents. A "general" ticket (legacy data only -- combined mode
// has been removed) is already one full admission by itself; day-specific
// tickets need one of EVERY currently-defined day to count as one complete
// set, so this takes the smallest count across ALL active day categories
// (defaulting missing ones to 0) rather than just the categories the member
// happens to hold -- someone with only a Day-1 coupon and no Day-2 one, in a
// 2-day event, has zero complete sets, not one.
function personEquivalentsFromCounts(counts, dayCats) {
  const generalCount = counts.general || 0;
  const daySets = dayCats.length ? Math.min.apply(null, dayCats.map((c) => counts[c] || 0)) : 0;
  return generalCount + daySets;
}

function countPersonEquivalents(memberId, eventId) {
  return personEquivalentsFromCounts(entryCouponCountsByCategory(memberId), activeDayCategories(eventId));
}

// Lucky Coupon eligibility rule: a member needs at least 2 complete entry
// admissions currently in hand. This is re-checked every time it's asked
// (not decided once at creation), so a member who transfers down to just
// their own single coupon loses it immediately, and one who is later given
// more can gain it.
function isLuckyEligible(memberId, eventId) {
  return countPersonEquivalents(memberId, eventId) >= 2;
}

// Returns the member's lucky_coupons row if (and only if) they're currently
// eligible -- creating one on first check if they don't have one yet, so
// the reveal has something to update later. Returns null when not
// eligible, which the summary API turns into "no Lucky Coupon at all" for
// that member (not just "not revealed yet") -- exactly what should happen
// if someone transfers away down to a single coupon.
function getLuckyForMember(eventId, memberId) {
  if (!isLuckyEligible(memberId, eventId)) return null;
  let lc = db.prepare('SELECT * FROM lucky_coupons WHERE event_id = ? AND member_id = ?').get(eventId, memberId);
  if (!lc) {
    const id = uid('lc');
    db.prepare('INSERT INTO lucky_coupons (id, event_id, member_id, prize, revealed) VALUES (?,?,?,NULL,0)').run(id, eventId, memberId);
    lc = { id, event_id: eventId, member_id: memberId, prize: null, revealed: 0 };
  }
  return lc;
}

// Run right before a reveal: makes sure every CURRENTLY eligible member has
// a lucky_coupons row to update, including anyone who became eligible after
// the fact and never happened to open their app (which is what normally
// lazily creates the row via getLuckyForMember above).
function ensureLuckyRowsForAllEligible(eventId) {
  db.prepare('SELECT id FROM members').all().forEach((m) => {
    if (isLuckyEligible(m.id, eventId)) getLuckyForMember(eventId, m.id);
  });
}

// ---------- member-facing API ----------

router.get('/api/members/:memberId/summary', (ctx) => {
  const { memberId } = ctx.params;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) return sendJson(ctx.res, 404, { ok: false, error: 'member_not_found' });

  const rows = db
    .prepare(
      `SELECT mp.*, pt.* , mp.id as mp_id, pt.id as pt_id FROM member_passes mp
       JOIN pass_types pt ON pt.id = mp.pass_type_id WHERE mp.member_id = ?`
    )
    .all(memberId);

  const now = Date.now();
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  // Precompute once so the "would transferring this drop me below the Lucky
  // Coupon threshold" check per-pass below doesn't re-query per pass.
  const dayCats = activeDayCategories(event.id);
  const currentCounts = entryCouponCountsByCategory(memberId);
  const currentlyEligible = luckyDrawEnabled() && personEquivalentsFromCounts(currentCounts, dayCats) >= 2;
  const passes = rows.map((r) => {
    const mp = { id: r.mp_id, status: r.status, used_at: r.used_at, transfer_count: r.transfer_count };
    const pt = {
      id: r.pt_id,
      title: r.title,
      description: r.description,
      category: r.category,
      icon: r.icon,
      is_all_days: r.is_all_days,
      window_start: r.window_start,
      window_end: r.window_end,
      activate_lead_minutes: r.activate_lead_minutes,
      transfer_limit: r.transfer_limit,
    };
    const serialized = serializePass(mp, pt, now);
    // Only meaningful for entry-coupon categories, and only when it's an
    // actual behaviour change worth warning about: they're eligible now,
    // but sending this specific one away would drop them below 2.
    if (currentlyEligible && r.status !== 'transferred' && (r.category === 'day1' || r.category === 'day2' || r.category === 'day3' || r.category === 'general')) {
      const afterCounts = Object.assign({}, currentCounts, { [r.category]: Math.max(0, (currentCounts[r.category] || 0) - 1) });
      serialized.couldLoseLucky = personEquivalentsFromCounts(afterCounts, dayCats) < 2;
    } else {
      serialized.couldLoseLucky = false;
    }
    return serialized;
  });

  const sponsors = db.prepare('SELECT * FROM sponsors ORDER BY sort_order').all().map(serializeSponsor);
  const lucky = luckyDrawEnabled() ? getLuckyForMember(event.id, memberId) : null;
  const rule = luckyDrawEnabled() ? db.prepare('SELECT * FROM reveal_rules WHERE event_id = ?').get(event.id) : null;

  // Incoming claim requests on any pass this member currently owns --
  // shown as an approve/reject prompt in their app.
  const pendingRows = db
    .prepare(
      `SELECT tr.*, pt.title as pass_title FROM transfer_requests tr
       JOIN member_passes mp ON mp.id = tr.member_pass_id
       JOIN pass_types pt ON pt.id = mp.pass_type_id
       WHERE mp.member_id = ? AND tr.status = 'pending'`
    )
    .all(memberId);
  const pendingRequests = pendingRows.map((r) => ({
    requestId: r.id,
    passId: r.member_pass_id,
    passTitle: r.pass_title,
    requesterName: r.requester_name,
    requesterWhatsapp: r.requester_whatsapp,
    createdAt: r.created_at,
  }));

  sendJson(ctx.res, 200, {
    ok: true,
    now,
    member: { id: member.id, name: member.name, isVip: !!member.is_vip },
    event,
    sponsors,
    passes,
    pendingRequests,
    lucky: lucky ? { revealed: !!lucky.revealed, prize: lucky.revealed ? lucky.prize : null } : null,
    luckyRule: rule ? { ruleNote: rule.rule_note, revealAt: rule.reveal_at, triggered: !!rule.triggered } : null,
  });
});

// Minting a QR is the real enforcement point: we only ever hand out a
// signed, short-lived token while the pass is genuinely 'active'.
router.post('/api/passes/:passId/qr', (ctx) => {
  const found = getPassWithType(ctx.params.passId);
  if (!found) return sendJson(ctx.res, 404, { ok: false, error: 'pass_not_found' });
  const now = Date.now();
  const state = computeState(found.memberPass, found.passType, now);
  if (state !== 'active') {
    return sendJson(ctx.res, 409, { ok: false, error: 'not_active', state });
  }
  // Token outlives "now" only briefly -- long enough to walk to the gate,
  // short enough that a screenshot can't be reused later. Tune to taste.
  const ttlMs = Math.min(5 * 60 * 1000, found.passType.window_end - now);
  const token = sign(found.memberPass.id, now + ttlMs, uid('n'));
  const verifyUrl = `${BASE_URL}/verify/${token}`;
  sendJson(ctx.res, 200, {
    ok: true,
    token,
    verifyUrl,
    expiresAt: now + ttlMs,
    qrSvgDataUri: encodeToSvgDataUri(verifyUrl),
  });
});

// ---------- gate verification (opened by any phone's camera app) ----------
// Only a browser that has previously opened this event's /scan/:deviceToken
// activation link (set by the organiser from /admin) may grant or deny
// entry -- closing the gap where a pass holder opens their own QR link
// early, or a leaked screenshot gets scanned from a random phone. The one
// bypass is the admin-only emergency form on /admin itself (same
// unguessable-link trust model as the rest of /admin), for when a scanner
// device is lost/broken/uncharged during the event and gate staff need a
// working fallback right away.
const SCANNER_COOKIE = 'gatepass_scanner';

function isScannerDeviceAuthorized(ctx) {
  const token = ctx.cookies && ctx.cookies[SCANNER_COOKIE];
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM scanner_devices WHERE token = ?').get(token);
}

function runVerification(token) {
  const result = verify(token);
  if (!result.ok) {
    return verifyResultPage(false, reasonToMessage(result.reason));
  }
  const found = getPassWithType(result.passId);
  if (!found) return verifyResultPage(false, 'This coupon no longer exists.');

  const now = Date.now();
  const state = computeState(found.memberPass, found.passType, now);
  if (state === 'used') {
    return verifyResultPage(false, `Already used at ${new Date(found.memberPass.used_at).toLocaleTimeString()}.`);
  }
  if (state !== 'active') {
    return verifyResultPage(false, `This coupon is ${state}, not open for entry right now.`);
  }

  db.prepare(`UPDATE member_passes SET status='used', used_at=? WHERE id=?`).run(now, found.memberPass.id);
  return verifyResultPage(true, `${found.passType.title} -- entry granted.`);
}

router.get('/verify/:token', (ctx) => {
  if (!isScannerDeviceAuthorized(ctx)) {
    return sendHtml(ctx.res, 200, verifyResultPage(false,
      'This device isn’t authorized to scan gate entries for this event. Ask the organiser to send you the activation link for this device (Admin → Gate scanner devices) and open it once here -- or, if it’s an emergency, the organiser can verify this exact code from /admin.'));
  }
  sendHtml(ctx.res, 200, runVerification(ctx.params.token));
});

function reasonToMessage(reason) {
  return { expired: 'This QR has expired -- ask the member to reopen their coupon for a fresh one.',
           bad_signature: 'This code was not issued by this system.',
           malformed: 'Unreadable code.' }[reason] || 'This code is not valid.';
}

// Manual fallback for staff without a camera handy. Same device-cookie gate
// applies since this just redirects into /verify/:token.
router.get('/staff', (ctx) => sendHtml(ctx.res, 200, staffPage()));
router.post('/staff/verify', (ctx) => {
  const token = (ctx.body.token || '').trim();
  ctx.res.writeHead(302, { Location: `/verify/${encodeURIComponent(token)}` });
  ctx.res.end();
});

// Opening this link once (from the organiser's /admin page, sent to
// whichever phone/tablet is doing gate scanning) marks THAT BROWSER as an
// authorized scanner via a long-lived cookie. Nothing else needs a login on
// the device itself -- the unguessable per-device token is the credential,
// same trust model as the /allot/:token links.
router.get('/scan/:token', (ctx) => {
  const device = db.prepare('SELECT * FROM scanner_devices WHERE token = ?').get(ctx.params.token);
  if (!device) return sendHtml(ctx.res, 404, pageShell('Not valid', '<div class="card"><p style="margin:0;">This device activation link isn\'t valid, or the organiser has revoked it. Ask them for a fresh one.</p></div>'));
  setCookie(ctx.res, SCANNER_COOKIE, device.token, 3650);
  sendHtml(ctx.res, 200, pageShell('Device activated', `<div class="card"><p style="margin:0;">✅ This device is now authorized to scan gate entries as <strong>${device.name.replace(/[<>&]/g, '')}</strong>. Leave this browser open (or bookmark <a href="/staff">/staff</a>) for the rest of the event -- you only need to open this link once.</p></div>`));
});

router.post('/admin/scanner-devices', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const name = (ctx.body.name || '').trim();
  if (!name) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  db.prepare('INSERT INTO scanner_devices (id, event_id, name, token, created_at) VALUES (?,?,?,?,?)')
    .run(uid('sd'), event.id, name, uid('scn'), Date.now());
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});
router.post('/admin/scanner-devices/:id/delete', (ctx) => {
  db.prepare('DELETE FROM scanner_devices WHERE id = ?').run(ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

// Emergency override: reachable ONLY from /admin (never linked anywhere a
// gate device or member would see it), for when an activated scanner device
// is lost/dead/uncharged mid-event and staff need to let someone in right
// now. Bypasses the device-cookie gate entirely -- deliberately not exposed
// as a bookmarkable gate-side page, so it stays something only the organiser
// (whoever has the /admin link) can reach.
router.post('/admin/emergency-verify', (ctx) => {
  const token = (ctx.body.token || '').trim();
  sendHtml(ctx.res, 200, runVerification(token));
});

// ---------- transfer flow ----------

// Shared by the owner-initiated flow (POST /api/transfer/initiate below)
// and the receiver-initiated flow (a claim request the owner approved,
// further down) -- both end up sending an OTP the same way.
function startTransferOtp(passId, fromMemberId, toWhatsapp) {
  const otp = generateOtp();
  const otpId = uid('tf');
  db.prepare(
    `INSERT INTO transfers (id, member_pass_id, from_member_id, to_whatsapp, otp_code, otp_expires_at, status, created_at)
     VALUES (?,?,?,?,?,?, 'pending', ?)`
  ).run(otpId, passId, fromMemberId, toWhatsapp, otp, Date.now() + 10 * 60000, Date.now());
  sendOtp(toWhatsapp, otp);
  return {
    transferId: otpId,
    devNote: 'No real WhatsApp message was sent -- see lib/notify.js. Demo OTP is ' + otp,
  };
}

router.post('/api/transfer/initiate', (ctx) => {
  const { passId, toWhatsapp } = ctx.body;
  const found = getPassWithType(passId);
  if (!found) return sendJson(ctx.res, 404, { ok: false, error: 'pass_not_found' });
  // A pass can only be initiated for transfer while it's still genuinely
  // held (not already used at the gate, and not already sent away by an
  // earlier transfer) -- without this check, initiating two transfers
  // against the same still-"active" pass before either is confirmed would
  // let both complete, minting two independent passes from one coupon.
  if (found.memberPass.status !== 'active') {
    return sendJson(ctx.res, 409, { ok: false, error: 'pass_not_available' });
  }
  if (found.memberPass.transfer_count >= found.passType.transfer_limit) {
    return sendJson(ctx.res, 409, { ok: false, error: 'transfer_limit_reached' });
  }
  if (!toWhatsapp || String(toWhatsapp).replace(/\D/g, '').length < 8) {
    return sendJson(ctx.res, 400, { ok: false, error: 'invalid_number' });
  }
  const { transferId, devNote } = startTransferOtp(passId, found.memberPass.member_id, toWhatsapp);
  sendJson(ctx.res, 200, { ok: true, transferId, devNote });
});

router.post('/api/transfer/confirm', (ctx) => {
  const { transferId, otp } = ctx.body;
  const tf = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  if (!tf) return sendJson(ctx.res, 404, { ok: false, error: 'transfer_not_found' });
  if (tf.status !== 'pending') return sendJson(ctx.res, 409, { ok: false, error: 'already_used' });
  if (Date.now() > tf.otp_expires_at) return sendJson(ctx.res, 410, { ok: false, error: 'otp_expired' });
  if (String(otp).trim() !== tf.otp_code) return sendJson(ctx.res, 401, { ok: false, error: 'wrong_otp' });

  const found = getPassWithType(tf.member_pass_id);
  if (!found) return sendJson(ctx.res, 404, { ok: false, error: 'pass_not_found' });
  // Re-check live status at confirm time too, not just at initiate time --
  // this is what actually closes the double-spend gap: if two transfers
  // were initiated against the same pass before either was confirmed, the
  // first confirm() to land flips this to 'transferred', so the second one
  // is correctly refused here instead of minting a second independent pass
  // from the same coupon. Also catches a pass that got scanned ('used') at
  // the gate while an OTP was still pending.
  if (found.memberPass.status !== 'active') {
    db.prepare(`UPDATE transfers SET status='expired' WHERE id=?`).run(transferId);
    return sendJson(ctx.res, 409, { ok: false, error: 'pass_no_longer_available' });
  }

  // If this OTP transfer came from an approved claim request, use the name
  // the receiver actually typed in on /claim/:passId instead of a generic
  // placeholder.
  const claimReq = db.prepare('SELECT * FROM transfer_requests WHERE transfer_id = ?').get(transferId);

  let receiver = db.prepare('SELECT * FROM members WHERE whatsapp = ?').get(tf.to_whatsapp);
  if (!receiver) {
    const newId = uid('mem');
    db.prepare('INSERT INTO members (id, name, whatsapp, created_at) VALUES (?,?,?,?)')
      .run(newId, claimReq ? claimReq.requester_name : 'New Member', tf.to_whatsapp, Date.now());
    receiver = { id: newId };
  }

  const newTransferCount = found.memberPass.transfer_count + 1;
  db.prepare(`UPDATE member_passes SET status='transferred' WHERE id=?`).run(found.memberPass.id);
  const newPassId = uid('mp');
  db.prepare(
    `INSERT INTO member_passes (id, pass_type_id, member_id, status, transfer_count) VALUES (?,?,?, 'active', ?)`
  ).run(newPassId, found.passType.id, receiver.id, newTransferCount);
  db.prepare(`UPDATE transfers SET status='confirmed' WHERE id=?`).run(transferId);

  sendJson(ctx.res, 200, { ok: true, newMemberId: receiver.id, newPassId });
});

// ---------- claim links (receiver-initiated transfer, owner approves) ----------
// Alternative to the owner typing the receiver's number themselves: the
// owner shares /claim/:passId (from their transfer sheet), whoever opens it
// requests the pass with their own name + WhatsApp number, and NOTHING
// moves until the owner (or the organiser, from /admin) approves that
// specific person. That approval is the member-to-member check; the OTP
// the receiver enters afterwards is still the phone check -- both apply.
//
// This only applies to a pass's FIRST-EVER transfer (transfer_count===0).
// Requiring every subsequent holder to sit through an approval step too
// would just pile up busywork without adding real security -- the
// original organiser-allotted holder is the one link in the chain worth
// double-checking. From the second transfer onward, the plain
// number-entry + OTP flow above is all that's offered.
function isFirstTransferEligible(memberPass, passType) {
  return memberPass.transfer_count === 0 && memberPass.transfer_count < passType.transfer_limit &&
    memberPass.status !== 'used' && memberPass.status !== 'transferred';
}

router.get('/api/passes/:passId/claim-info', (ctx) => {
  const found = getPassWithType(ctx.params.passId);
  if (!found) return sendJson(ctx.res, 404, { ok: false, error: 'pass_not_found' });
  let reason = null;
  if (found.memberPass.transfer_count > 0) reason = 'first_transfer_only';
  else if (found.memberPass.status === 'used' || found.memberPass.status === 'transferred') reason = 'not_available';
  else if (found.memberPass.transfer_count >= found.passType.transfer_limit) reason = 'transfer_limit_reached';
  sendJson(ctx.res, 200, {
    ok: true,
    title: found.passType.title,
    description: found.passType.description,
    transferable: !reason,
    reason,
  });
});

router.post('/api/claim/:passId/request', (ctx) => {
  const { passId } = ctx.params;
  const found = getPassWithType(passId);
  if (!found) return sendJson(ctx.res, 404, { ok: false, error: 'pass_not_found' });
  if (!isFirstTransferEligible(found.memberPass, found.passType)) {
    return sendJson(ctx.res, 409, { ok: false, error: 'not_eligible_for_claim_link' });
  }
  const name = (ctx.body.name || '').trim();
  const whatsapp = (ctx.body.whatsapp || '').trim();
  if (!name) return sendJson(ctx.res, 400, { ok: false, error: 'name_required' });
  if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) {
    return sendJson(ctx.res, 400, { ok: false, error: 'invalid_number' });
  }
  const id = uid('treq');
  db.prepare(
    `INSERT INTO transfer_requests (id, member_pass_id, requester_name, requester_whatsapp, status, created_at)
     VALUES (?,?,?,?, 'pending', ?)`
  ).run(id, passId, name, whatsapp, Date.now());
  sendJson(ctx.res, 200, { ok: true, requestId: id });
});

router.get('/api/claim-requests/:id', (ctx) => {
  const r = db.prepare('SELECT * FROM transfer_requests WHERE id = ?').get(ctx.params.id);
  if (!r) return sendJson(ctx.res, 404, { ok: false, error: 'request_not_found' });
  sendJson(ctx.res, 200, { ok: true, status: r.status, transferId: r.transfer_id || null });
});

function approveTransferRequest(requestId) {
  const r = db.prepare('SELECT * FROM transfer_requests WHERE id = ?').get(requestId);
  if (!r) return { ok: false, error: 'request_not_found' };
  if (r.status !== 'pending') return { ok: false, error: 'already_decided' };
  const found = getPassWithType(r.member_pass_id);
  if (!found) return { ok: false, error: 'pass_not_found' };
  // Re-check eligibility at approval time too -- the owner could have
  // transferred this pass some other way between the request and now.
  if (!isFirstTransferEligible(found.memberPass, found.passType)) {
    return { ok: false, error: 'no_longer_eligible' };
  }
  const { transferId, devNote } = startTransferOtp(r.member_pass_id, found.memberPass.member_id, r.requester_whatsapp);
  db.prepare(`UPDATE transfer_requests SET status='approved', transfer_id=? WHERE id=?`).run(transferId, requestId);
  return { ok: true, transferId, devNote };
}

router.post('/api/transfer-requests/:id/approve', (ctx) => {
  const result = approveTransferRequest(ctx.params.id);
  sendJson(ctx.res, result.ok ? 200 : 409, result);
});

router.post('/api/transfer-requests/:id/reject', (ctx) => {
  const r = db.prepare('SELECT * FROM transfer_requests WHERE id = ?').get(ctx.params.id);
  if (!r) return sendJson(ctx.res, 404, { ok: false, error: 'request_not_found' });
  if (r.status !== 'pending') return sendJson(ctx.res, 409, { ok: false, error: 'already_decided' });
  db.prepare(`UPDATE transfer_requests SET status='rejected' WHERE id=?`).run(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true });
});

// Same two actions, reachable from /admin as a fallback approver (a plain
// redirect-based form post, for whoever is looking after the event rather
// than the pass's current owner).
router.post('/admin/transfer-requests/:id/approve', (ctx) => {
  approveTransferRequest(ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});
router.post('/admin/transfer-requests/:id/reject', (ctx) => {
  db.prepare(`UPDATE transfer_requests SET status='rejected' WHERE id=? AND status='pending'`).run(ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

router.get('/claim/:passId', (ctx) => sendHtml(ctx.res, 200, claimPage(ctx.params.passId)));

// ---------- lucky coupon ----------

router.post('/api/admin/lucky/:eventId/reveal', (ctx) => {
  if (!luckyDrawEnabled()) return sendJson(ctx.res, 409, { ok: false, error: 'lucky_draw_disabled' });
  const { eventId } = ctx.params;
  const prizePool = ctx.body.prizes || [
    'Front-row Day 2 upgrade', 'Meet & greet backstage pass', 'Merch hamper',
    'Better luck next year -- 10% off your next coupon',
  ];
  ensureLuckyRowsForAllEligible(eventId);
  const coupons = db.prepare('SELECT * FROM lucky_coupons WHERE event_id = ? AND revealed = 0').all(eventId);
  const upd = db.prepare('UPDATE lucky_coupons SET revealed = 1, prize = ? WHERE id = ?');
  coupons.forEach((c) => upd.run(prizePool[Math.floor(Math.random() * prizePool.length)], c.id));
  db.prepare('UPDATE reveal_rules SET triggered = 1 WHERE event_id = ?').run(eventId);
  sendJson(ctx.res, 200, { ok: true, revealedCount: coupons.length });
});

// ---------- admin (config) ----------

router.get('/admin', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  ensureEntryCouponPassTypes(event.id);
  const sponsors = db.prepare('SELECT * FROM sponsors ORDER BY sort_order').all();
  const passTypes = db.prepare(
    `SELECT * FROM pass_types WHERE event_id = ? AND category IN ('day1','day2','day3','general') ORDER BY category`
  ).all(event.id);
  const rule = db.prepare('SELECT * FROM reveal_rules WHERE event_id = ?').get(event.id);
  const sampleMember = db.prepare('SELECT * FROM members LIMIT 1').get();
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM members').get().c;
  const recentMembers = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM member_passes mp WHERE mp.member_id = m.id AND mp.status != 'transferred') as coupon_count
     FROM members m ORDER BY m.created_at DESC LIMIT 15`
  ).all();
  // Their currently-cancellable coupons -- only 'active' ones, attached
  // per-member so the "fix a mistake" row can offer a cancel button per
  // coupon without a separate round trip per member.
  const activePassesByMemberQuery = db.prepare(
    `SELECT mp.id, pt.title, pt.category FROM member_passes mp
     JOIN pass_types pt ON pt.id = mp.pass_type_id
     WHERE mp.member_id = ? AND mp.status = 'active' ORDER BY pt.category`
  );
  recentMembers.forEach((m) => { m.activePasses = activePassesByMemberQuery.all(m.id); });
  const allotters = db.prepare('SELECT * FROM allotters WHERE event_id = ? AND revoked = 0 ORDER BY created_at DESC').all(event.id);
  // Each allotter's own additions attached here (not a separate query per
  // page section) so /admin can show "who has this person added" per
  // allotter without a second round trip.
  const membersByAllotterQuery = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM member_passes mp WHERE mp.member_id = m.id AND mp.status != 'transferred') as coupon_count
     FROM members m WHERE m.allotted_by = ? ORDER BY m.created_at DESC`
  );
  allotters.forEach((a) => { a.addedMembers = membersByAllotterQuery.all(a.name); });
  const pendingRequests = db
    .prepare(
      `SELECT tr.*, pt.title as pass_title, m.name as owner_name FROM transfer_requests tr
       JOIN member_passes mp ON mp.id = tr.member_pass_id
       JOIN pass_types pt ON pt.id = mp.pass_type_id
       JOIN members m ON m.id = mp.member_id
       WHERE tr.status = 'pending' ORDER BY tr.created_at DESC`
    )
    .all();
  const pendingAllotmentRequests = db
    .prepare(
      `SELECT r.*, a.name as approver_name FROM pass_allotment_requests r
       JOIN allotters a ON a.id = r.approver_id
       WHERE r.status = 'pending' ORDER BY r.created_at DESC`
    )
    .all();
  const scannerDevices = db.prepare('SELECT * FROM scanner_devices WHERE event_id = ? ORDER BY created_at DESC').all(event.id);

  // transfer_count = 0 marks a pass's ORIGINAL row -- the one created at
  // allotment time, regardless of what happened to it since -- so counting
  // those (not all member_passes rows, which also include the extra row
  // each transfer creates) gives the true "how many were ever allotted"
  // number. status='transferred' rows are old, superseded copies kept only
  // for history, so they're excluded from the "currently held" counts.
  const passStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM member_passes WHERE transfer_count = 0) as totalAllotted,
      (SELECT COUNT(*) FROM member_passes WHERE status = 'active') as active,
      (SELECT COUNT(*) FROM member_passes WHERE status = 'used') as used,
      (SELECT COUNT(*) FROM transfers WHERE status = 'confirmed') as totalTransfers
  `).get();
  // Same numbers, broken down per day -- "how many Day 1 coupons are out
  // there and how many of those have actually walked through the gate" is
  // what an organiser standing at the gate actually wants to know, not just
  // one event-wide total.
  const passStatsByDay = db.prepare(`
    SELECT pt.category,
      COUNT(*) FILTER (WHERE mp.transfer_count = 0) as totalAllotted,
      COUNT(*) FILTER (WHERE mp.status = 'active') as active,
      COUNT(*) FILTER (WHERE mp.status = 'used') as used
    FROM member_passes mp
    JOIN pass_types pt ON pt.id = mp.pass_type_id
    WHERE pt.category IN ('day1','day2','day3')
    GROUP BY pt.category
    ORDER BY pt.category
  `).all();
  // Every completed transfer, newest first -- who gave which pass to which
  // number, and (when that number matches an existing member -- it always
  // will after the transfer completes, since confirming one creates the
  // receiver if they're new) who they are.
  const transferHistory = db.prepare(`
    SELECT t.id, t.created_at, t.to_whatsapp, t.status,
           fm.name as from_name, fm.whatsapp as from_whatsapp,
           pt.title as pass_title,
           rm.name as to_name
    FROM transfers t
    JOIN member_passes mp ON mp.id = t.member_pass_id
    JOIN pass_types pt ON pt.id = mp.pass_type_id
    JOIN members fm ON fm.id = t.from_member_id
    LEFT JOIN members rm ON rm.whatsapp = t.to_whatsapp
    WHERE t.status = 'confirmed'
    ORDER BY t.created_at DESC
    LIMIT 200
  `).all();

  sendHtml(ctx.res, 200, adminPage({
    event, sponsors, passTypes, rule, sampleMemberId: sampleMember ? sampleMember.id : null, memberCount, recentMembers,
    pendingRequests, pendingAllotmentRequests, allotters, scannerDevices, baseUrl: BASE_URL,
    passStats, passStatsByDay, transferHistory,
    luckyDrawEnabled: luckyDrawEnabled(),
    flash: {
      added: ctx.query.get('added'),
      existing: ctx.query.get('existing'),
      bulkCreated: ctx.query.get('bulk_created'),
      bulkBlank: ctx.query.get('bulk_blank'),
      bulkDuplicate: ctx.query.get('bulk_duplicate'),
      bulkLimitBlocked: ctx.query.get('bulk_limit_blocked'),
      error: ctx.query.get('error'),
      remaining: ctx.query.get('remaining'),
      eventSaved: ctx.query.get('event_saved'),
      sponsorAdded: ctx.query.get('sponsor_added'),
      sponsorEdited: ctx.query.get('sponsor_edited'),
      allotterAdded: ctx.query.get('allotter_added'),
      limitUpdated: ctx.query.get('limit_updated'),
      memberEdited: ctx.query.get('member_edited'),
      memberDeleted: ctx.query.get('member_deleted'),
      couponCancelled: ctx.query.get('coupon_cancelled'),
    },
  }));
});

// Editing name/venue/dates here updates the live database row directly --
// unlike event.config.js (which only seeds these once, the very first time
// the server ever starts with no existing data/ folder), this always takes
// effect immediately, on an event that's already running with real members.
router.post('/admin/event-details', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const name = (ctx.body.name || '').trim() || event.name;
  const venue = (ctx.body.venue || '').trim();
  const startAt = ctx.body.start_at ? new Date(ctx.body.start_at).getTime() : event.start_at;
  const endAt = ctx.body.end_at ? new Date(ctx.body.end_at).getTime() : event.end_at;
  db.prepare('UPDATE events SET name = ?, venue = ?, start_at = ?, end_at = ? WHERE id = ?')
    .run(name, venue, startAt, endAt, event.id);
  if (startAt !== event.start_at || endAt !== event.end_at) {
    reflowPassTypeWindows(event.id, startAt, endAt);
  }
  ctx.res.writeHead(302, { Location: '/admin?event_saved=1' });
  ctx.res.end();
});

// The one rule governing every Entry Coupon's re-transferability. Applied
// retroactively to every currently active pass type so it can't drift into
// different values depending on when each one was created.
router.post('/admin/transfer-limit', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  if (event.published) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const limit = Math.max(0, Math.floor(Number(ctx.body.transfer_limit)) || 0);
  applyTransferLimit(event.id, limit);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

// Locks the transfer-limit rule (and, in effect, the Entry Coupon
// day-structure, since it's auto-managed from the event's dates rather than
// hand-edited) so it isn't casually re-decided over and over once the
// organiser has settled on it. Unpublish any time to go back to editing.
router.post('/admin/publish', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  db.prepare('UPDATE events SET published = 1 WHERE id = ?').run(event.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});
router.post('/admin/unpublish', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  db.prepare('UPDATE events SET published = 0 WHERE id = ?').run(event.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

router.post('/admin/sponsors', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM sponsors').get().m;
  const b = ctx.body;
  db.prepare(
    `INSERT INTO sponsors (id, event_id, name, tier, sort_order, tagline, website_url, contact_url, logo_data_uri)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    uid('sp'), event.id, b.name, b.tier, maxOrder + 1,
    b.tagline || null, b.website_url || null, b.contact_url || null,
    (b.logo_data_uri && b.logo_data_uri.startsWith('data:image/')) ? b.logo_data_uri : null
  );
  ctx.res.writeHead(302, { Location: '/admin?sponsor_added=1' });
  ctx.res.end();
});

// Edit an existing sponsor -- same fields as adding one, so a wrong/test
// website or WhatsApp link (or a logo swap) can be fixed in place instead of
// deleting and re-adding, which would also lose its position in the list.
// Leaving the logo field empty keeps whatever logo it already had.
router.post('/admin/sponsors/:id/edit', (ctx) => {
  const b = ctx.body;
  const existing = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(ctx.params.id);
  if (!existing) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const newLogo = (b.logo_data_uri && b.logo_data_uri.startsWith('data:image/')) ? b.logo_data_uri : existing.logo_data_uri;
  db.prepare(
    `UPDATE sponsors SET name=?, tier=?, tagline=?, website_url=?, contact_url=?, logo_data_uri=? WHERE id=?`
  ).run(
    (b.name || '').trim() || existing.name, b.tier || existing.tier,
    b.tagline || null, b.website_url || null, b.contact_url || null,
    newLogo, ctx.params.id
  );
  ctx.res.writeHead(302, { Location: '/admin?sponsor_edited=1' });
  ctx.res.end();
});

router.post('/admin/sponsors/:id/delete', (ctx) => {
  db.prepare('DELETE FROM sponsors WHERE id = ?').run(ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

router.post('/admin/reveal-now', (ctx) => {
  if (!luckyDrawEnabled()) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  ensureLuckyRowsForAllEligible(event.id);
  const coupons = db.prepare('SELECT * FROM lucky_coupons WHERE event_id = ? AND revealed = 0').all(event.id);
  const prizePool = ['Front-row Day 2 upgrade', 'Meet & greet backstage pass', 'Merch hamper', 'Better luck next year -- 10% off your next coupon'];
  const upd = db.prepare('UPDATE lucky_coupons SET revealed = 1, prize = ? WHERE id = ?');
  coupons.forEach((c) => upd.run(prizePool[Math.floor(Math.random() * prizePool.length)], c.id));
  db.prepare('UPDATE reveal_rules SET triggered = 1 WHERE event_id = ?').run(event.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

// Lets the organiser write/update the human-readable rule that members see
// on the Grand Finale card before the Lucky Coupon reveal (e.g. "revealed
// once the closing set ends") -- separate from actually triggering it above.
router.post('/admin/lucky-rule', (ctx) => {
  if (!luckyDrawEnabled()) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const b = ctx.body;
  const revealAt = b.reveal_at ? new Date(b.reveal_at).getTime() : event.end_at;
  db.prepare('UPDATE reveal_rules SET rule_note = ?, reveal_at = ? WHERE event_id = ?')
    .run(b.rule_note || '', revealAt, event.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

// ---------- pass allotment (organiser issues passes to attendees) ----------
// This is an invite/allotment model, not a paid checkout: the organiser
// (who already knows who's on their guest list, or has taken payment
// outside this tool) creates each member and hands them their passes here.
// Swap in a real payment gateway in front of this if you want a public,
// self-serve "buy a pass" page -- these routes are what it would call
// after payment succeeds.
//
// Both single-add and bulk forms now ask for a QUANTITY plus which day(s)
// -- not a checklist of individual pass-type rows -- so it's impossible to
// submit having accidentally selected nothing (day checkboxes come
// pre-checked, and the server rejects a submission with none checked or a
// quantity under 1, instead of silently creating a member with zero
// coupons the way the old raw-checkbox form could).
function selectedDayCategories(body) {
  return ENTRY_CATEGORIES.filter((cat) => body['day_' + cat] === 'on');
}

// VIP is a property of the MEMBER, not of any pass they hold -- so it's set
// here, once, rather than as a pass-type category. It never travels with a
// transfer: a VIP member giving a coupon away just hands over a normal
// entry coupon, and the receiver (a different member row entirely) has
// their own is_vip flag, untouched, defaulting to 0 unless they're
// separately flagged. Only the organiser's own admin forms can set this --
// authorized allotters and the self-service request flow never can.
// quantityUnits is the exact "quantity" typed into whichever form is
// creating this member -- recorded once, at creation, since an existing
// member is never re-issued coupons on a re-submit (see isNew below). It's
// what lets an allotter's usage be restored precisely if this member later
// turns out to be a mistake and gets deleted (see the member-delete route).
function findOrCreateMember(name, whatsapp, allottedBy, isVip, quantityUnits) {
  const existing = db.prepare('SELECT * FROM members WHERE whatsapp = ?').get(whatsapp);
  if (existing) {
    if (isVip && !existing.is_vip) db.prepare('UPDATE members SET is_vip = 1 WHERE id = ?').run(existing.id);
    return { member: existing, isNew: false };
  }
  const id = uid('mem');
  db.prepare('INSERT INTO members (id, name, whatsapp, created_at, allotted_by, is_vip, quantity_units) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, whatsapp, Date.now(), allottedBy || null, isVip ? 1 : 0, quantityUnits || 0);
  return { member: { id, name, whatsapp, is_vip: isVip ? 1 : 0, quantity_units: quantityUnits || 0 }, isNew: true };
}

router.post('/admin/members', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const b = ctx.body;
  const name = (b.name || '').trim();
  const whatsapp = (b.whatsapp || '').trim();
  const days = selectedDayCategories(b);
  const quantity = Math.max(1, Math.floor(Number(b.quantity) || 1));
  // A whitespace-only name/number used to slip through here (`b.name ||
  // 'New Member'` only catches a genuinely EMPTY string, not " ") and
  // create an unreachable, nameless member -- reject it outright instead.
  if (!name || !whatsapp) {
    ctx.res.writeHead(302, { Location: '/admin?error=missing_details' });
    return ctx.res.end();
  }
  if (!days.length) {
    ctx.res.writeHead(302, { Location: '/admin?error=no_days_selected' });
    return ctx.res.end();
  }
  const { member, isNew } = findOrCreateMember(name, whatsapp, 'Organiser', b.is_vip === 'on', quantity);
  // Only issue coupons for a genuinely NEW member -- same protection bulk
  // allotment already had. Without this, a double-click or a stale
  // back-button resubmit of this form with the same WhatsApp number would
  // silently mint another full `quantity` batch on top of what they
  // already have.
  if (isNew) {
    allotEntryCouponUnits(event.id, member.id, quantity, days);
    ctx.res.writeHead(302, { Location: '/admin?added=' + encodeURIComponent(member.id) });
  } else {
    ctx.res.writeHead(302, { Location: '/admin?existing=' + encodeURIComponent(member.id) });
  }
  ctx.res.end();
});

// Bulk allotment: paste "Name,WhatsApp" one per line (e.g. exported from a
// spreadsheet) -- every line gets the same quantity, day(s), and VIP flag.
router.post('/admin/members/bulk', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const b = ctx.body;
  const days = selectedDayCategories(b);
  const quantity = Math.max(1, Math.floor(Number(b.quantity) || 1));
  if (!days.length) {
    ctx.res.writeHead(302, { Location: '/admin?error=no_days_selected' });
    return ctx.res.end();
  }
  const isVip = b.is_vip === 'on';
  const lines = String(b.csv || '').split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);
  let created = 0, duplicate = 0, blank = 0;
  lines.forEach((line) => {
    const [name, whatsapp] = line.split(',').map((s) => (s || '').trim());
    if (!name || !whatsapp) { blank++; return; }
    const { member, isNew } = findOrCreateMember(name, whatsapp, 'Organiser', isVip, quantity);
    if (!isNew) { duplicate++; return; } // already existed -- don't re-issue coupons on a re-paste
    allotEntryCouponUnits(event.id, member.id, quantity, days);
    created++;
  });
  ctx.res.writeHead(302, { Location: `/admin?bulk_created=${created}&bulk_blank=${blank}&bulk_duplicate=${duplicate}` });
  ctx.res.end();
});

// ---------- fixing a mistake: edit / cancel-a-coupon / delete a member ----------
// Three separate, deliberately narrow corrections instead of one big "edit
// everything" form: a typo in the name/number, one wrongly-issued coupon
// (wrong day, duplicate line in a bulk paste, etc.), or the whole member
// being a mistake outright. Each is undoable independently.

// Fix a typo in a member's name or WhatsApp number (or flip their VIP flag)
// without touching any coupon they already hold. WhatsApp has a UNIQUE
// constraint -- changing it to a number that already belongs to someone
// else is rejected with a clear error instead of a raw SQLite exception.
router.post('/admin/members/:id/edit', (ctx) => {
  const b = ctx.body;
  const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(ctx.params.id);
  if (!existing) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const name = (b.name || '').trim() || existing.name;
  const whatsapp = (b.whatsapp || '').trim() || existing.whatsapp;
  const clash = whatsapp !== existing.whatsapp && db.prepare('SELECT 1 FROM members WHERE whatsapp = ? AND id != ?').get(whatsapp, existing.id);
  if (clash) {
    ctx.res.writeHead(302, { Location: '/admin?error=whatsapp_taken' });
    return ctx.res.end();
  }
  db.prepare('UPDATE members SET name = ?, whatsapp = ?, is_vip = ? WHERE id = ?')
    .run(name, whatsapp, b.is_vip === 'on' ? 1 : 0, existing.id);
  ctx.res.writeHead(302, { Location: '/admin?member_edited=1' });
  ctx.res.end();
});

// Cancel ONE wrongly-issued coupon (e.g. an extra day ticked by mistake, or
// a duplicate line in a bulk paste) without touching the member's other
// coupons. Only an 'active' (never scanned, never transferred) coupon can
// be cancelled this way -- taking back one that's already been used at the
// gate, or that's already moved on to someone else, isn't a "fix a mistake"
// action any more, it's rewriting what already happened. Deliberately does
// NOT adjust any allotter's usage count: one quantity "unit" can span
// several day-rows, so cancelling a single row doesn't map cleanly back to
// a fraction of a unit -- if freeing up allotter room is the goal, deleting
// the whole member below (which does restore it exactly) or just raising
// their limit are the reliable ways to do that.
router.post('/admin/member-passes/:id/cancel', (ctx) => {
  const mp = db.prepare('SELECT * FROM member_passes WHERE id = ?').get(ctx.params.id);
  if (!mp) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  if (mp.status !== 'active') {
    ctx.res.writeHead(302, { Location: '/admin?error=coupon_not_cancellable' });
    return ctx.res.end();
  }
  // A still-'active' coupon can have a pending claim/transfer request sitting
  // against it (see the pass_not_available comments above) -- clear those
  // first so the delete below doesn't hit the foreign_keys=ON constraint.
  db.prepare('DELETE FROM transfer_requests WHERE member_pass_id = ?').run(mp.id);
  db.prepare('DELETE FROM transfers WHERE member_pass_id = ?').run(mp.id);
  db.prepare('DELETE FROM member_passes WHERE id = ?').run(mp.id);
  ctx.res.writeHead(302, { Location: '/admin?coupon_cancelled=1' });
  ctx.res.end();
});

// Remove a member added by mistake entirely -- every coupon they hold goes
// with them. If they were added through a capped allotter's link, that
// allotter's usage is restored by their exact quantity_units (see
// findOrCreateMember above), so a corrected mistake doesn't permanently eat
// into someone's limit.
router.post('/admin/members/:id/delete', (ctx) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(ctx.params.id);
  if (!member) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const passIds = db.prepare('SELECT id FROM member_passes WHERE member_id = ?').all(member.id).map((r) => r.id);
  if (passIds.length) {
    const placeholders = passIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM transfer_requests WHERE member_pass_id IN (${placeholders})`).run(...passIds);
    db.prepare(`DELETE FROM transfers WHERE member_pass_id IN (${placeholders})`).run(...passIds);
  }
  // Keep the allotment-request record for the organiser's history -- just
  // unlink it from the member being removed (member_id is nullable).
  db.prepare('UPDATE pass_allotment_requests SET member_id = NULL WHERE member_id = ?').run(member.id);
  db.prepare('DELETE FROM lucky_coupons WHERE member_id = ?').run(member.id);
  db.prepare('DELETE FROM member_passes WHERE member_id = ?').run(member.id);
  db.prepare('DELETE FROM members WHERE id = ?').run(member.id);
  if (member.allotted_by && member.quantity_units) {
    const allotter = db.prepare('SELECT * FROM allotters WHERE name = ?').get(member.allotted_by);
    if (allotter) {
      db.prepare('UPDATE allotters SET allotted_count = MAX(0, allotted_count - ?) WHERE id = ?').run(member.quantity_units, allotter.id);
    }
  }
  ctx.res.writeHead(302, { Location: '/admin?member_deleted=1' });
  ctx.res.end();
});

// ---------- allotment access (organiser-authorized allotters) ----------
// For events allotting passes in batches through a handful of trusted
// people (team leads, sponsors' desks, whoever) instead of one organiser
// doing every single one -- each authorized person gets their own
// unguessable /allot/:token link that can ONLY add members and issue
// passes, nothing else on /admin. The organiser can add or revoke these
// at any time from /admin, and every member created this way records who
// added them (`members.allotted_by`) for accountability.

// A short, easy-to-say code (not the private token) that requesters type
// into the public /request form to route their request to this approver.
function generateAllotterCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(10 + Math.random() * 90));
    if (!db.prepare('SELECT 1 FROM allotters WHERE code = ?').get(code)) return code;
  }
  return String(Date.now()).slice(-4); // pathological fallback, practically unreachable
}

router.post('/admin/allotters', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const b = ctx.body;
  const name = (b.name || '').trim();
  if (!name) { ctx.res.writeHead(302, { Location: '/admin' }); return ctx.res.end(); }
  const token = uid('alt');
  const maxAllotments = String(b.max_allotments || '').trim() === '' ? null : Math.max(0, Math.floor(Number(b.max_allotments)));
  db.prepare('INSERT INTO allotters (id, event_id, name, whatsapp, token, code, can_single_day, grants_vip, max_allotments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(uid('al'), event.id, name, (b.whatsapp || '').trim() || null, token, generateAllotterCode(),
      b.can_single_day === 'on' ? 1 : 0, b.grants_vip === 'on' ? 1 : 0, maxAllotments, Date.now());
  ctx.res.writeHead(302, { Location: '/admin?allotter_added=1' });
  ctx.res.end();
});

// Adjusting an allotter's cap after the fact -- e.g. raising it once they've
// proven reliable, or lowering it if too many coupons went out. Leaving the
// field blank removes the cap entirely (unlimited); it never touches
// allotted_count, so their running total keeps counting from where it was.
router.post('/admin/allotters/:id/limit', (ctx) => {
  const raw = String(ctx.body.max_allotments || '').trim();
  const maxAllotments = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
  db.prepare('UPDATE allotters SET max_allotments = ? WHERE id = ?').run(maxAllotments, ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin?limit_updated=1' });
  ctx.res.end();
});

// "Revoke" -- a soft delete (see the `revoked` column comment in lib/db.js).
// An allotter who has ever received even one coupon request (approved,
// rejected, or still pending -- that row is never removed) can't be hard-
// DELETEd: pass_allotment_requests.approver_id is a NOT NULL foreign key
// with no ON DELETE clause, so that used to throw a raw FOREIGN KEY
// constraint error here instead of revoking. Flipping `revoked` instead
// stops their token/code working immediately (see the queries below) while
// keeping the request/approval history intact for the organiser's records.
router.post('/admin/allotters/:id/delete', (ctx) => {
  db.prepare('UPDATE allotters SET revoked = 1 WHERE id = ?').run(ctx.params.id);
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

function getAllotterByToken(token) {
  return db.prepare('SELECT * FROM allotters WHERE token = ? AND revoked = 0').get(token);
}

router.get('/allot/:token', (ctx) => {
  const allotter = getAllotterByToken(ctx.params.token);
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  // Same self-heal /admin does -- without this, an allotter link opened
  // before anyone has ever loaded /admin would find no Entry Coupon pass
  // types yet, and a can_single_day=false allotter (who always issues
  // "every currently active day" with no picker shown) would silently
  // issue zero passes per unit while still reporting success.
  if (allotter) ensureEntryCouponPassTypes(event.id);
  const passTypes = allotter
    ? db.prepare(`SELECT * FROM pass_types WHERE event_id = ? AND category IN ('day1','day2','day3') ORDER BY category`).all(event.id)
    : [];
  const addedMembers = allotter
    // Only THIS allotter's own additions -- not everyone's, so one
    // authorized person can't see another's list of who they added. Matched
    // by allotter id (via members.allotted_by storing the allotter's name)
    // -- also carries a live coupon count per member for the table.
    ? db.prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM member_passes mp WHERE mp.member_id = m.id AND mp.status != 'transferred') as coupon_count
         FROM members m WHERE m.allotted_by = ? ORDER BY m.created_at DESC`
      ).all(allotter.name)
    : [];
  const pendingCouponRequests = allotter
    ? db.prepare(`SELECT * FROM pass_allotment_requests WHERE approver_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(allotter.id)
    : [];
  sendHtml(ctx.res, 200, allotPage({
    valid: !!allotter, token: ctx.params.token, allotter, event, passTypes, addedMembers, pendingCouponRequests,
    flash: {
      added: ctx.query.get('added'), existing: ctx.query.get('existing'),
      bulkCreated: ctx.query.get('bulk_created'),
      bulkBlank: ctx.query.get('bulk_blank'), bulkDuplicate: ctx.query.get('bulk_duplicate'),
      bulkLimitBlocked: ctx.query.get('bulk_limit_blocked'),
      error: ctx.query.get('error'),
      remaining: ctx.query.get('remaining'),
    },
  }));
});

router.post('/allot/:token/members', (ctx) => {
  const allotter = getAllotterByToken(ctx.params.token);
  if (!allotter) return sendHtml(ctx.res, 404, 'Invalid or revoked link.');
  const b = ctx.body;
  const name = (b.name || '').trim();
  const whatsapp = (b.whatsapp || '').trim();
  const quantity = Math.max(1, Math.floor(Number(b.quantity) || 1));
  if (!name || !whatsapp) {
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?error=missing_details` });
    return ctx.res.end();
  }
  // Not permitted to pick single days? Always all currently-active days --
  // no picker is even shown on their page for this case (see allotPage()),
  // this is the defense-in-depth match for that.
  const days = allotter.can_single_day ? selectedDayCategories(b) : ENTRY_CATEGORIES;
  if (!days.length) {
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?error=no_days_selected` });
    return ctx.res.end();
  }
  const isVip = allotter.grants_vip && b.is_vip === 'on';
  // Checked BEFORE creating the member -- a capped allotter who's out of
  // room shouldn't have a member created at all for this attempt (that
  // would silently "use up" a slot with zero coupons issued, and block a
  // legitimate retry with the same WhatsApp number via the duplicate check).
  const remaining = allotterCapacityError(allotter, quantity);
  if (remaining != null) {
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?error=limit_exceeded&remaining=${remaining}` });
    return ctx.res.end();
  }
  const { member, isNew } = findOrCreateMember(name, whatsapp, allotter.name, isVip, quantity);
  // Same duplicate-issue protection as the admin single-add route above --
  // only a genuinely new member gets coupons issued.
  if (isNew) {
    allotEntryCouponUnits(allotter.event_id, member.id, quantity, days);
    recordAllotterUsage(allotter.id, quantity);
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?added=` + encodeURIComponent(member.id) });
  } else {
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?existing=` + encodeURIComponent(member.id) });
  }
  ctx.res.end();
});

router.post('/allot/:token/members/bulk', (ctx) => {
  const allotter = getAllotterByToken(ctx.params.token);
  if (!allotter) return sendHtml(ctx.res, 404, 'Invalid or revoked link.');
  const b = ctx.body;
  const quantity = Math.max(1, Math.floor(Number(b.quantity) || 1));
  const days = allotter.can_single_day ? selectedDayCategories(b) : ENTRY_CATEGORIES;
  if (!days.length) {
    ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?error=no_days_selected` });
    return ctx.res.end();
  }
  const isVip = allotter.grants_vip && b.is_vip === 'on';
  const lines = String(b.csv || '').split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);
  // Running total across this whole paste, checked line by line -- a capped
  // allotter can fill up their remaining room partway through a big paste;
  // the rest are skipped (not partially issued) and called out separately
  // in the flash message rather than silently dropped.
  let usedSoFar = allotter.allotted_count;
  let created = 0, blank = 0, duplicate = 0, limitBlocked = 0;
  lines.forEach((line) => {
    const [name, whatsapp] = line.split(',').map((s) => (s || '').trim());
    if (!name || !whatsapp) { blank++; return; }
    if (allotter.max_allotments != null && usedSoFar + quantity > allotter.max_allotments) { limitBlocked++; return; }
    const { member, isNew } = findOrCreateMember(name, whatsapp, allotter.name, isVip, quantity);
    if (!isNew) { duplicate++; return; }
    allotEntryCouponUnits(allotter.event_id, member.id, quantity, days);
    recordAllotterUsage(allotter.id, quantity);
    usedSoFar += quantity;
    created++;
  });
  ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}?bulk_created=${created}&bulk_blank=${blank}&bulk_duplicate=${duplicate}&bulk_limit_blocked=${limitBlocked}` });
  ctx.res.end();
});

// ---------- self-service coupon requests (name + WhatsApp + quantity + an approver's code) ----------
// Instead of an allotter typing in every single recipient's details --
// tedious once someone needs a double-digit number of coupons -- the person
// who needs them can request their own batch: their own name, their own
// WhatsApp number, how many they need, and the short code of whichever
// authorized approver they were told to use. Nothing is issued until that
// specific approver reviews name+number+quantity and approves (optionally
// with a note) or rejects. On approval, ONE member (the requester) is
// created holding that many entry coupons -- see allotEntryCouponUnits().
function getAllotterByCode(code) {
  return db.prepare('SELECT * FROM allotters WHERE code = ? AND revoked = 0').get(String(code || '').trim());
}

router.get('/request', (ctx) => sendHtml(ctx.res, 200, requestPage()));

router.post('/api/allotment-requests', (ctx) => {
  const b = ctx.body;
  const name = (b.name || '').trim();
  const whatsapp = (b.whatsapp || '').trim();
  const quantity = Math.floor(Number(b.quantity));
  if (!name) return sendJson(ctx.res, 400, { ok: false, error: 'name_required' });
  if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return sendJson(ctx.res, 400, { ok: false, error: 'invalid_number' });
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) return sendJson(ctx.res, 400, { ok: false, error: 'invalid_quantity' });
  const approver = getAllotterByCode(b.code);
  if (!approver) return sendJson(ctx.res, 404, { ok: false, error: 'invalid_code' });
  const id = uid('areq');
  db.prepare(
    `INSERT INTO pass_allotment_requests (id, requester_name, requester_whatsapp, quantity, approver_id, status, created_at)
     VALUES (?,?,?,?,?, 'pending', ?)`
  ).run(id, name, whatsapp, quantity, approver.id, Date.now());
  sendJson(ctx.res, 200, { ok: true, requestId: id });
});

router.get('/api/allotment-requests/:id', (ctx) => {
  const r = db.prepare('SELECT * FROM pass_allotment_requests WHERE id = ?').get(ctx.params.id);
  if (!r) return sendJson(ctx.res, 404, { ok: false, error: 'not_found' });
  // Deliberately no `note` field here -- the approver's note is internal
  // record-keeping, never shown to the requester (not even in the raw API
  // response this status page polls).
  sendJson(ctx.res, 200, { ok: true, status: r.status, quantity: r.quantity, memberId: r.member_id || null });
});

// Shared by all three places an allotter's link issues coupons (single add,
// bulk add, and approving a self-service request below) -- null means the
// allotter has no cap (max_allotments is NULL) or this issuance fits under
// it; otherwise returns how many units they actually have left, so callers
// can show a real number instead of a generic refusal.
function allotterCapacityError(allotter, quantity) {
  if (!allotter || allotter.max_allotments == null) return null;
  const remaining = allotter.max_allotments - allotter.allotted_count;
  if (quantity > remaining) return Math.max(0, remaining);
  return null;
}
function recordAllotterUsage(allotterId, quantity) {
  db.prepare('UPDATE allotters SET allotted_count = allotted_count + ? WHERE id = ?').run(quantity, allotterId);
}

function approveAllotmentRequest(requestId, note) {
  const r = db.prepare('SELECT * FROM pass_allotment_requests WHERE id = ?').get(requestId);
  if (!r) return { ok: false, error: 'not_found' };
  if (r.status !== 'pending') return { ok: false, error: 'already_decided' };
  const approver = db.prepare('SELECT * FROM allotters WHERE id = ?').get(r.approver_id);
  const remaining = allotterCapacityError(approver, r.quantity);
  if (remaining != null) return { ok: false, error: 'limit_exceeded', remaining };
  const eventId = approver ? approver.event_id : db.prepare('SELECT id FROM events LIMIT 1').get().id;
  const { member } = findOrCreateMember(r.requester_name, r.requester_whatsapp, approver ? approver.name : 'Approver', false, r.quantity);
  allotEntryCouponUnits(eventId, member.id, r.quantity);
  if (approver) recordAllotterUsage(approver.id, r.quantity);
  db.prepare(`UPDATE pass_allotment_requests SET status='approved', note=?, member_id=? WHERE id=?`).run(note || null, member.id, requestId);
  sendMessage(r.requester_whatsapp, `Your ${r.quantity} entry coupon(s) are ready: ${BASE_URL}/app/${member.id}`);
  return { ok: true, memberId: member.id };
}

function rejectAllotmentRequest(requestId, note) {
  const r = db.prepare('SELECT * FROM pass_allotment_requests WHERE id = ?').get(requestId);
  if (!r) return { ok: false, error: 'not_found' };
  if (r.status !== 'pending') return { ok: false, error: 'already_decided' };
  db.prepare(`UPDATE pass_allotment_requests SET status='rejected', note=? WHERE id=?`).run(note || null, requestId);
  return { ok: true };
}

// Reachable only from the specific approver's own /allot/:token page.
router.post('/allot/:token/requests/:id/approve', (ctx) => {
  const allotter = getAllotterByToken(ctx.params.token);
  if (!allotter) return sendHtml(ctx.res, 404, 'Invalid or revoked link.');
  const r = db.prepare('SELECT * FROM pass_allotment_requests WHERE id = ?').get(ctx.params.id);
  if (!r || r.approver_id !== allotter.id) return sendHtml(ctx.res, 404, 'Not found.');
  const result = approveAllotmentRequest(ctx.params.id, (ctx.body.note || '').trim());
  const suffix = result.ok ? '' : `?error=${result.error}${result.remaining != null ? '&remaining=' + result.remaining : ''}`;
  ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}${suffix}` });
  ctx.res.end();
});
router.post('/allot/:token/requests/:id/reject', (ctx) => {
  const allotter = getAllotterByToken(ctx.params.token);
  if (!allotter) return sendHtml(ctx.res, 404, 'Invalid or revoked link.');
  const r = db.prepare('SELECT * FROM pass_allotment_requests WHERE id = ?').get(ctx.params.id);
  if (!r || r.approver_id !== allotter.id) return sendHtml(ctx.res, 404, 'Not found.');
  rejectAllotmentRequest(ctx.params.id, (ctx.body.note || '').trim());
  ctx.res.writeHead(302, { Location: `/allot/${ctx.params.token}` });
  ctx.res.end();
});
// Same two actions from /admin, as oversight/fallback if the named approver
// is unavailable -- same pattern as the transfer-request fallback above.
router.post('/admin/allotment-requests/:id/approve', (ctx) => {
  const result = approveAllotmentRequest(ctx.params.id, (ctx.body.note || '').trim());
  const suffix = result.ok ? '' : `?error=${result.error}${result.remaining != null ? '&remaining=' + result.remaining : ''}`;
  ctx.res.writeHead(302, { Location: `/admin${suffix}` });
  ctx.res.end();
});
router.post('/admin/allotment-requests/:id/reject', (ctx) => {
  rejectAllotmentRequest(ctx.params.id, (ctx.body.note || '').trim());
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

// ---------- customer-facing app (static, but data-driven via the API above) ----------

const APP_HTML_PATH = path.join(__dirname, 'public_app', 'index.html');
function serveApp(ctx) {
  sendHtml(ctx.res, 200, fs.readFileSync(APP_HTML_PATH, 'utf8'));
}
router.get('/app', serveApp);
router.get('/app/:memberId', serveApp);

// Testing convenience only -- shifts every pass_type's window so "Day 1" is
// active right now, instead of waiting for real event dates. Remove this
// route (or put it behind auth) before running a real event.
router.post('/admin/testing/open-now', (ctx) => {
  const event = db.prepare('SELECT * FROM events LIMIT 1').get();
  const now = Date.now();
  const HOUR = 3600 * 1000;
  const rows = db.prepare('SELECT id FROM pass_types WHERE event_id = ?').all(event.id);
  const upd = db.prepare('UPDATE pass_types SET window_start=?, window_end=?, activate_lead_minutes=1 WHERE id=?');
  rows.forEach((r) => upd.run(now - 60000, now + 6 * HOUR, r.id));
  ctx.res.writeHead(302, { Location: '/admin' });
  ctx.res.end();
});

router.get('/', (ctx) => {
  const member = db.prepare('SELECT * FROM members LIMIT 1').get();
  const sampleLines = member
    ? `<li><a href="/app/${member.id}">/app/${member.id}</a> -- the customer-facing app, as that member would see it (this is the link an organiser sends)</li>
      <li><code>GET /api/members/${member.id}/summary</code> -- the raw JSON the app above is built from</li>`
    : `<li>No members yet -- add one from /admin, and their app link will work.</li>`;
  sendHtml(ctx.res, 200, pageShell('GatePass API server', `
    <p>Useful starting points:</p>
    <ul>
      ${sampleLines}
      <li><a href="/admin">/admin</a> -- organiser config (sponsors, coupon types, lucky reveal)</li>
      <li><a href="/staff">/staff</a> -- manual gate-code entry for staff</li>
    </ul>
  `));
});

const server = http.createServer((req, res) => router.handle(req, res));
server.listen(PORT, () => {
  console.log(`GatePass server running at ${BASE_URL}`);
  const member = db.prepare('SELECT * FROM members LIMIT 1').get();
  if (member) console.log(`Try: curl ${BASE_URL}/api/members/${member.id}/summary`);
});
