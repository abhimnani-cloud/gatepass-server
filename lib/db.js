// Storage layer. Uses Node's built-in node:sqlite (no npm dependency, no
// native compile step) so this project runs with nothing but `node`.
// Requires Node 22.5+; on older 22.x builds this API sits behind a flag,
// which is why package.json's start script passes --experimental-sqlite
// (harmless if your Node version doesn't need it).

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DATA_DIR can be overridden with an env var -- this matters on hosts like
// Render/Railway where the persistent disk gets mounted at a path *you*
// choose (e.g. /var/data), which usually won't match this repo's own
// folder layout. Locally, with no env var set, it just falls back to the
// same server/data folder as before.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'gatepass.sqlite');

const isFirstRun = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
-- The published flag locks the core rules below (transfer_limit, and
-- effectively the day structure since Entry Coupons are auto-managed from
-- it) once the organiser is done deciding them, so they don't drift
-- mid-event from repeated changes. Unpublish from /admin any time to edit
-- again.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  day_mode TEXT NOT NULL DEFAULT 'per_day',
  transfer_limit INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 0,
  poster_data_uri TEXT,
  logo_data_uri TEXT
);

-- 'associate' sits between 'title' and 'powered' -- it exists for a
-- "co-presented by / in association with / powered by / supported by"
-- style sponsor hierarchy (more tiers than the original 3), without
-- disturbing events that only ever used the original three.
CREATE TABLE IF NOT EXISTS sponsors (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('title','associate','powered','partner')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  tagline TEXT,
  website_url TEXT,
  contact_url TEXT,
  logo_data_uri TEXT
);

-- A pass_type is one configurable "kind" of pass/coupon an organiser
-- defines: VIP All-Access, Day 1 Entry, Day 2 Meal Voucher, etc.
-- Every member who holds that kind gets one row in member_passes.
CREATE TABLE IF NOT EXISTS pass_types (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('vip','day1','day2','day3','extra','general')),
  is_all_days INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  activate_lead_minutes INTEGER NOT NULL DEFAULT 45,
  transfer_limit INTEGER NOT NULL DEFAULT 1,
  icon TEXT NOT NULL DEFAULT '🎟️'
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  allotted_by TEXT,
  is_vip INTEGER NOT NULL DEFAULT 0
);

-- A person the organiser has personally authorized to register first-time
-- attendees (in batches, e.g. 10 at a time) without handing them the full
-- /admin panel. Each gets their own unguessable link (/allot/:token) that
-- only exposes "add member + issue passes" -- no sponsors, pass types, or
-- lucky reveal. The organiser can add or revoke these at any time. The
-- code column is a short, spoken-aloud-friendly number (e.g. "23") separate
-- from the private token -- it's what a requester types into the public
-- /request form to route their coupon request to this specific approver.
-- can_single_day: 0 (default) means this allotter's own add-member forms
-- always allot EVERY currently-active day's coupon at once, with no day
-- picker shown at all (removes any chance of accidentally submitting with
-- nothing selected). 1 means the organiser trusts them to hand out
-- single-day-only coupons too (e.g. a day-2 walk-in desk), so their forms
-- show a day picker.
-- grants_vip: whether this allotter's own forms even show a "Mark as VIP"
-- checkbox. Off by default -- VIP is meant to be an organiser-level call.
CREATE TABLE IF NOT EXISTS allotters (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  whatsapp TEXT,
  token TEXT NOT NULL UNIQUE,
  code TEXT UNIQUE,
  can_single_day INTEGER NOT NULL DEFAULT 0,
  grants_vip INTEGER NOT NULL DEFAULT 0,
  -- "Revoke" soft-deletes rather than DELETEs this row: pass_allotment_requests
  -- has a NOT NULL foreign key to allotters(id) with no ON DELETE clause, and
  -- foreign_keys=ON, so a hard DELETE on an allotter who has ever received a
  -- single coupon request (pending, approved, or rejected -- the row is never
  -- removed) throws a FOREIGN KEY constraint error instead of revoking. Soft
  -- delete sidesteps that without a schema-breaking migration, and keeps the
  -- request/approval audit trail intact.
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- A phone/tablet the organiser has activated for gate scanning. Opening
-- /scan/:token once (from /admin) marks that BROWSER as authorized via a
-- long-lived cookie; /verify/:qrToken (what an actual pass's QR encodes)
-- then refuses to grant or deny entry from any browser that was never
-- activated this way -- closing the gap where a pass holder could open
-- their own QR's link early, or a leaked screenshot could be scanned from
-- an unauthorized phone. Revoking a device here does not un-set cookies
-- already issued (there's no session store to invalidate against) -- swap
-- GATEPASS_SECRET if a device is compromised and you need a hard cutover.
CREATE TABLE IF NOT EXISTS scanner_devices (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One row per browser that has successfully logged into /admin with the
-- organiser password (event.config.js -> ADMIN_PASSWORD, or the
-- ADMIN_PASSWORD env var on a live host). The cookie only ever holds this
-- random session token, never the password itself -- logging out, or
-- deleting a row here, revokes that one browser without changing the
-- password for everyone else.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- A self-service request for a batch of entry coupons: someone who needs
-- several coupons (e.g. a group representative needing 16) submits their
-- own name/WhatsApp/quantity plus an approver's short code, instead of the
-- approver having to type in every recipient's details one at a time. The
-- named approver reviews name+number+quantity and approves or rejects
-- (with an optional note); nothing is issued until they do. On approval,
-- ONE member is created (the requester) holding as many entry coupons as
-- the approved quantity -- they redistribute individual coupons to their
-- group afterwards using the normal transfer/claim-link flow, same as any
-- other member.
CREATE TABLE IF NOT EXISTS pass_allotment_requests (
  id TEXT PRIMARY KEY,
  requester_name TEXT NOT NULL,
  requester_whatsapp TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  approver_id TEXT NOT NULL REFERENCES allotters(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  member_id TEXT REFERENCES members(id),
  created_at INTEGER NOT NULL
);

-- One issued, holder-specific pass/coupon.
CREATE TABLE IF NOT EXISTS member_passes (
  id TEXT PRIMARY KEY,
  pass_type_id TEXT NOT NULL REFERENCES pass_types(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','transferred')),
  used_at INTEGER,
  transfer_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  member_pass_id TEXT NOT NULL REFERENCES member_passes(id),
  from_member_id TEXT NOT NULL REFERENCES members(id),
  to_whatsapp TEXT NOT NULL,
  otp_code TEXT NOT NULL,
  otp_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lucky_coupons (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  prize TEXT,
  revealed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(event_id, member_id)
);

-- A receiver-initiated claim on someone else's pass, made via the public
-- /claim/:passId link (rather than the owner typing the receiver's number
-- themselves). Nothing moves until the current owner (or the organiser)
-- approves it -- that approval is a member-to-member check that sits
-- alongside, not instead of, the WhatsApp OTP in the transfers table.
CREATE TABLE IF NOT EXISTS transfer_requests (
  id TEXT PRIMARY KEY,
  member_pass_id TEXT NOT NULL REFERENCES member_passes(id),
  requester_name TEXT NOT NULL,
  requester_whatsapp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  transfer_id TEXT REFERENCES transfers(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reveal_rules (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  reveal_at INTEGER NOT NULL,
  rule_note TEXT,
  triggered INTEGER NOT NULL DEFAULT 0
);
`);

// Lightweight migration for databases created before a column existed --
// CREATE TABLE IF NOT EXISTS above only helps on a brand-new database, so
// anyone upgrading an already-running install needs these ADD COLUMNs too.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true; // freshly added -- caller can use this to run a one-time backfill
  }
  return false;
}
ensureColumn('sponsors', 'tagline', 'tagline TEXT');
ensureColumn('sponsors', 'website_url', 'website_url TEXT');
ensureColumn('sponsors', 'contact_url', 'contact_url TEXT');
ensureColumn('sponsors', 'logo_data_uri', 'logo_data_uri TEXT');
ensureColumn('pass_types', 'icon', "icon TEXT NOT NULL DEFAULT '🎟️'");
ensureColumn('events', 'day_mode', "day_mode TEXT NOT NULL DEFAULT 'per_day'");
ensureColumn('members', 'allotted_by', 'allotted_by TEXT');

// VIP used to be a pass_types.category value (shared by everyone holding
// that pass type); it's now a per-member flag instead, so a sponsor who
// transfers a coupon away doesn't hand their VIP status to the receiver --
// the receiver is just a normal member with a normal coupon. Existing
// installs need a one-time backfill: anyone currently holding a pass whose
// category is still 'vip' gets flagged here so they don't lose their badge
// during the upgrade. This only needs to run once -- ensureColumn's
// "does the column already exist" check doubles as that guard.
(function migrateVipToMemberFlag() {
  const cols = db.prepare("PRAGMA table_info(members)").all();
  if (cols.some((c) => c.name === 'is_vip')) return;
  db.exec("ALTER TABLE members ADD COLUMN is_vip INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE members SET is_vip = 1 WHERE id IN (
      SELECT DISTINCT mp.member_id FROM member_passes mp
      JOIN pass_types pt ON pt.id = mp.pass_type_id
      WHERE pt.category = 'vip'
    )
  `);
})();

ensureColumn('allotters', 'code', 'code TEXT');
ensureColumn('allotters', 'can_single_day', 'can_single_day INTEGER NOT NULL DEFAULT 0');
ensureColumn('allotters', 'grants_vip', 'grants_vip INTEGER NOT NULL DEFAULT 0');
ensureColumn('allotters', 'revoked', 'revoked INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'transfer_limit', 'transfer_limit INTEGER NOT NULL DEFAULT 1');
ensureColumn('events', 'published', 'published INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'poster_data_uri', 'poster_data_uri TEXT');
ensureColumn('events', 'logo_data_uri', 'logo_data_uri TEXT');

// The exact "quantity" (sets/units) typed into whichever allotment form
// created this member -- one coupon unit becomes several member_passes rows
// (one per day it covers), so this is NOT the same as counting their rows.
// Set explicitly by the app at creation time going forward (server.js);
// existing members from before this column existed are backfilled just
// below, right before it's needed to seed allotters.allotted_count.
const membersQuantityColIsNew = ensureColumn('members', 'quantity_units', 'quantity_units INTEGER');
if (membersQuantityColIsNew) {
  // Reconstruct it from their originally-issued (transfer_count = 0) rows:
  // dividing by how many distinct day-categories those rows span recovers
  // the original "quantity" exactly, as long as it divides evenly (the
  // normal case -- one allotment always used one quantity across whichever
  // days were picked). If it doesn't divide evenly (mixed history from an
  // even older schema), fall back to the raw row count -- an overcount
  // errs on the side of NOT letting a capped allotter look like they have
  // more room than they actually used.
  db.exec(`
    UPDATE members SET quantity_units = COALESCE((
      SELECT CASE
        WHEN COUNT(DISTINCT pt.category) > 0 AND COUNT(*) % COUNT(DISTINCT pt.category) = 0
        THEN COUNT(*) / COUNT(DISTINCT pt.category)
        ELSE COUNT(*)
      END
      FROM member_passes mp JOIN pass_types pt ON pt.id = mp.pass_type_id
      WHERE mp.member_id = members.id AND mp.transfer_count = 0
    ), 0)
  `);
}

// max_allotments: optional cap on how many coupon "units" (the same
// quantity number typed into the allotment forms, not raw pass rows) one
// allotter may ever issue in total -- NULL means unlimited. allotted_count
// is the running total, kept in sync by the app every time that allotter's
// link successfully issues coupons (server.js), so tracking is exact going
// forward without re-deriving it from pass history on every page load.
const allottersLimitColsAreNew = ensureColumn('allotters', 'max_allotments', 'max_allotments INTEGER');
ensureColumn('allotters', 'allotted_count', 'allotted_count INTEGER NOT NULL DEFAULT 0');
if (allottersLimitColsAreNew) {
  // One-time backfill for allotters that already had members before this
  // feature existed -- summing each member's reconstructed quantity_units
  // (above) instead of just counting members, so someone previously given
  // quantity > 1 in a single past allotment is no longer undercounted.
  db.exec(`
    UPDATE allotters SET allotted_count = (
      SELECT COALESCE(SUM(m.quantity_units), 0) FROM members m WHERE m.allotted_by = allotters.name
    )
  `);
}

// Same rebuild-the-table trick as migratePassTypesCategoryCheck below --
// a database created before 'associate' was a valid sponsors.tier still
// has the old 3-value constraint baked in. No other table has a foreign
// key pointing at sponsors(id), so this one doesn't need the
// foreign_keys-off dance that pass_types' rebuild does.
(function migrateSponsorsTierCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sponsors'").get();
  if (!row || !row.sql || row.sql.includes("'associate'")) return;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE sponsors RENAME TO sponsors_old');
    db.exec(`
      CREATE TABLE sponsors (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        name TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('title','associate','powered','partner')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        tagline TEXT,
        website_url TEXT,
        contact_url TEXT,
        logo_data_uri TEXT
      )
    `);
    db.exec(`
      INSERT INTO sponsors (id,event_id,name,tier,sort_order,tagline,website_url,contact_url,logo_data_uri)
      SELECT id,event_id,name,tier,sort_order,tagline,website_url,contact_url,logo_data_uri FROM sponsors_old
    `);
    db.exec('DROP TABLE sponsors_old');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
})();

// Every allotter needs a short, easy-to-say code for the coupon-request
// form (separate from their private /allot/:token link) -- backfill one
// for any row that doesn't have it yet (existing installs, or the column
// having just been added above).
(function migrateAllotterCodes() {
  const missing = db.prepare('SELECT id FROM allotters WHERE code IS NULL').all();
  if (!missing.length) return;
  const used = new Set(db.prepare('SELECT code FROM allotters WHERE code IS NOT NULL').all().map((r) => r.code));
  const upd = db.prepare('UPDATE allotters SET code = ? WHERE id = ?');
  missing.forEach((row) => {
    let code;
    do { code = String(Math.floor(10 + Math.random() * 90)); } while (used.has(code));
    used.add(code);
    upd.run(code, row.id);
  });
})();

// A CHECK constraint can't be widened with ALTER TABLE ADD COLUMN -- a
// database created before 'general' was a valid pass_types.category still
// has the old constraint baked in, so rebuild the table if that's the one
// installed. Fresh installs already get the new constraint from the
// CREATE TABLE above and this is a no-op for them.
(function migratePassTypesCategoryCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pass_types'").get();
  if (!row || !row.sql || row.sql.includes("'general'")) return;
  // member_passes.pass_type_id REFERENCES pass_types(id), and SQLite
  // auto-updates that reference to point at "pass_types_old" the moment we
  // RENAME the table below (this is intentional SQLite behaviour, not a
  // bug in it) -- so by the time we DROP TABLE pass_types_old, any real
  // member_passes rows still point at it, and dropping a table something
  // else still references throws "FOREIGN KEY constraint failed". SQLite's
  // own documented workaround for exactly this table-rebuild pattern is to
  // turn enforcement off for the duration, outside the transaction on both
  // ends (turning it off/on *inside* BEGIN/COMMIT has no effect).
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE pass_types RENAME TO pass_types_old');
      db.exec(`
        CREATE TABLE pass_types (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
          title TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL CHECK (category IN ('vip','day1','day2','day3','extra','general')),
          is_all_days INTEGER NOT NULL DEFAULT 0,
          window_start INTEGER NOT NULL,
          window_end INTEGER NOT NULL,
          activate_lead_minutes INTEGER NOT NULL DEFAULT 45,
          transfer_limit INTEGER NOT NULL DEFAULT 1,
          icon TEXT NOT NULL DEFAULT '🎟️'
        )
      `);
      db.exec(`
        INSERT INTO pass_types (id,event_id,title,description,category,is_all_days,window_start,window_end,activate_lead_minutes,transfer_limit,icon)
        SELECT id,event_id,title,description,category,is_all_days,window_start,window_end,activate_lead_minutes,transfer_limit,icon FROM pass_types_old
      `);
      db.exec('DROP TABLE pass_types_old');
      // member_passes' foreign key got auto-repointed to pass_types_old on
      // rename above; now that the real pass_types table exists again under
      // its original name with the same ids, fix that reference back so
      // future foreign-key enforcement checks against the right table.
      db.exec(`
        CREATE TABLE member_passes_new (
          id TEXT PRIMARY KEY,
          pass_type_id TEXT NOT NULL REFERENCES pass_types(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','transferred')),
          used_at INTEGER,
          transfer_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec(`
        INSERT INTO member_passes_new (id,pass_type_id,member_id,status,used_at,transfer_count)
        SELECT id,pass_type_id,member_id,status,used_at,transfer_count FROM member_passes
      `);
      db.exec('DROP TABLE member_passes');
      db.exec('ALTER TABLE member_passes_new RENAME TO member_passes');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
})();

function uid(prefix) {
  return prefix + '_' + require('crypto').randomBytes(6).toString('hex');
}

if (isFirstRun) {
  seed();
}

function seed() {
  const cfg = require('./event.config');
  const now = Date.now();
  const eventId = 'ev_horizon';
  const day1Start = new Date(cfg.DAY1_START).getTime();
  const day1End = new Date(cfg.DAY1_END).getTime();
  const day2Start = new Date(cfg.DAY2_START).getTime();
  const day2End = new Date(cfg.DAY2_END).getTime();
  const festEnd = new Date(cfg.REVEAL_AT).getTime();

  db.prepare(`INSERT INTO events (id, name, venue, start_at, end_at, poster_data_uri, logo_data_uri) VALUES (?,?,?,?,?,?,?)`)
    .run(eventId, cfg.EVENT_NAME, cfg.EVENT_VENUE, day1Start, day2End, cfg.POSTER_DATA_URI || null, cfg.LOGO_DATA_URI || null);

  const insSponsor = db.prepare(
    `INSERT INTO sponsors (id,event_id,name,tier,sort_order,tagline,website_url,contact_url,logo_data_uri) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  (cfg.SPONSORS || []).forEach((s, order) =>
    insSponsor.run(uid('sp'), eventId, s.name, s.tier, order, s.tagline || null, s.website || null, s.contact || null, s.logo || null)
  );

  // Only "Entry Coupon" pass types exist going forward -- one per day (or
  // one combined "general" pass, in combined day-mode). These two rows are
  // what ensureEntryCouponPassTypes() in server.js would auto-create for a
  // fresh per_day event anyway; seeding them directly here just avoids an
  // extra round-trip on first boot.
  const passTypes = [
    ['Day 1 Entry', 'Gate entry for day 1 of the event.', 'day1', 0, day1Start, day1End, 45, 1, '🎫'],
    ['Day 2 Entry', 'Gate entry for day 2 of the event.', 'day2', 0, day2Start, day2End, 45, 1, '🎫'],
  ];
  const insPassType = db.prepare(
    `INSERT INTO pass_types (id,event_id,title,description,category,is_all_days,window_start,window_end,activate_lead_minutes,transfer_limit,icon)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const passTypeIds = passTypes.map(([title, desc, category, allDays, ws, we, lead, limit, icon]) => {
    const id = uid('pt');
    insPassType.run(id, eventId, title, desc, category, allDays, ws, we, lead, limit, icon);
    return id;
  });

  db.prepare(`INSERT INTO reveal_rules (event_id, reveal_at, rule_note, triggered) VALUES (?,?,?,0)`)
    .run(eventId, festEnd, 'Revealed together for every eligible member once the organiser announces results on stage.');

  if (cfg.SEED_DEMO_MEMBERS) {
    // Aman holds TWO full (Day 1 + Day 2) sets -- one for himself, one he
    // hasn't handed off yet -- so he's a ready-made example of someone
    // eligible for the Lucky Coupon (>=2 person-equivalents held).
    const memberId = uid('mem');
    db.prepare(`INSERT INTO members (id, name, whatsapp, created_at, is_vip) VALUES (?,?,?,?,0)`)
      .run(memberId, 'Aman Verma', '+919800000001', now);
    const insMemberPass = db.prepare(
      `INSERT INTO member_passes (id, pass_type_id, member_id, status) VALUES (?,?,?, 'active')`
    );
    for (let i = 0; i < 2; i++) passTypeIds.forEach((ptId) => insMemberPass.run(uid('mp'), ptId, memberId));

    // Priya is a sponsor contact the organiser has flagged VIP -- she holds
    // just one set for herself (not eligible for the Lucky Coupon, since the
    // VIP flag doesn't add extra coupons on its own).
    const vipMemberId = uid('mem');
    db.prepare(`INSERT INTO members (id, name, whatsapp, created_at, is_vip) VALUES (?,?,?,?,1)`)
      .run(vipMemberId, 'Priya (Nimbus)', '+919800000099', now);
    passTypeIds.forEach((ptId) => insMemberPass.run(uid('mp'), ptId, vipMemberId));

    // One ready-to-use allotter so the request+approve flow can be tried
    // immediately: share /request plus this code with anyone who needs a
    // batch of coupons.
    db.prepare(`INSERT INTO allotters (id, event_id, name, whatsapp, token, code, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(uid('al'), eventId, 'Ravi Kumar', null, uid('alt'), '23', now);

    console.log('Seeded demo data: event "' + cfg.EVENT_NAME + '", member Aman Verma (' + memberId + '), VIP member Priya (' + vipMemberId + ')');
  } else {
    console.log('Seeded event "' + cfg.EVENT_NAME + '" -- no demo members (SEED_DEMO_MEMBERS is false). Add real members from /admin.');
  }
}

module.exports = { db, uid };
