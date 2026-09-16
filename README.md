# GatePass server

A backend for a digital event entry-pass platform: time-locked QR gate
entry, WhatsApp-verified pass/coupon transfers, tiered sponsor listings,
and an organiser-triggered "Lucky Coupon" reveal.

This is a starter/reference implementation, not a finished product --
see **What's mocked vs. real** below before you rely on it for a live
event.

## Why zero npm dependencies

The environment this was built in had no access to the npm registry, so
everything here runs on Node's built-in modules only:

- **Storage**: `node:sqlite` (built into Node 22.5+), not `better-sqlite3`.
- **HTTP**: a ~50-line router on top of `node:http` (`lib/router.js`), not Express.
- **QR codes**: a vendored copy of the standard MIT-licensed "QRCode for
  JavaScript" encoder (`lib/qrencoder/`, see its `NOTICE.md`), not the
  `qrcode` npm package.

This isn't a constraint you need to keep -- if your own machine has
normal internet access, feel free to swap any of these for `express`,
`better-sqlite3`, etc. The logic in `server.js` doesn't care either way.

## Requirements

- Node.js **22.5 or newer** (for `node:sqlite`). Check with `node -v`.

## Run it

```
cd server
npm start
```

This seeds a demo event ("Horizon Music & Arts Fest") with two members --
Aman Verma (holding two full Day 1 + Day 2 sets, so he's eligible for the
Lucky Coupon) and Priya, a VIP-flagged sponsor contact holding just one set
(not Lucky Coupon-eligible, since VIP alone doesn't add extra coupons) --
plus one ready-to-use allotter (code `23`) so you can try the coupon-request
flow immediately. It prints Aman's member ID and a sample `curl` command to
try. Data persists in `data/gatepass.sqlite` between restarts -- run
`npm run reset-data` to wipe it and reseed on next start.

Open:
- `/app/<memberId>` -- **the member-facing app**, connected to this
  live backend (real data, real QR minting, real transfers). The
  member ID printed at startup gives you a working link straight away,
  e.g. `/app/mem_17ea7b362ec4`. This is what you'd send to a real
  attendee (as a WhatsApp link, once you've deployed it somewhere with
  a real domain).
- `GET /api/members/<id>/summary` -- the same member's passes as raw
  JSON, if you want to build a different frontend against this backend
- `/admin` -- organiser config: add sponsors, set the transfer rule,
  authorize allotters and scanner devices, trigger the Lucky Coupon
  reveal. It also links straight to the demo member's `/app/<id>` page,
  and has an **"Open everything now (testing only)"** button that shifts
  every pass type's active window to right now -- use this so you don't
  have to wait for real event hours while testing locally.
- `/staff` -- manual gate-code entry, for when a camera isn't handy. Like
  `/verify/:token`, this only works from a browser that has opened one of
  the gate-scanner activation links below first.
- `/request` -- public self-service coupon request form (name, WhatsApp,
  quantity, an approver's short code) -- see "Coupon requests" below

## How the core mechanics work

**Time-locked QR.** A QR is never pre-generated and handed out. The
member's app calls `POST /api/passes/:passId/qr`; the server checks the
pass's current state (`lib/state.js`) and *refuses* unless it's
`active` (i.e. within `activate_lead_minutes` of the window start, and
before the window end). Only then does it mint a signed, short-lived
token (`lib/token.js`, HMAC-SHA256) and encode it into a real QR
(`lib/qr.js`) that points at `/verify/:token`.

**Gate scanning needs no app of ours -- but only an organiser-authorized
device can act as a scanner.** The QR encodes an ordinary URL. Any
phone's stock camera app opens it, which hits `GET /verify/:token` on
this server. That route re-checks the signature, expiry and single-use
status server-side, marks the pass `used` if valid, and returns a plain
HTML "Entry granted" / "Not valid" page -- no jsQR, no custom scanner
app needed. On top of that, `/verify/:token` (and the `/staff` manual
fallback, since it just redirects into `/verify/:token`) now refuses to
grant or deny anything unless the requesting browser has previously
opened that device's own `/scan/:deviceToken` activation link, set from
`/admin` → "Gate scanner devices." Opening that link once sets a
long-lived cookie marking that specific browser as authorized; nothing
else about the device needs a login. This closes the gap where a pass
holder could open their own QR's link early to check its state, or a
leaked screenshot could be scanned from a random uninvolved phone. If
every authorized device is lost, dead, or uncharged mid-event, the
"Emergency override" form right below the device list on `/admin` lets
the organiser paste the exact code from a pass and verify that one entry
directly, bypassing the device check -- it deliberately isn't linked
from anywhere a gate device or member would stumble onto it, so it stays
something only whoever holds the `/admin` link can reach.

**Transfers are two API calls.** `POST /api/transfer/initiate` checks
the pass's `transfer_limit`, generates an OTP, and calls
`lib/notify.js` (mocked -- see below). `POST /api/transfer/confirm`
checks the OTP, creates the receiving member if they're new, reassigns
the pass, and marks the original `transferred` (so it can never be
scanned again).

**Claim links add a second, member-to-member check.** The flow above
assumes the owner already knows the receiver's WhatsApp number and types
it in themselves. The transfer sheet also offers "Copy claim link"
(`/claim/:passId`) for when they don't -- the receiver opens that public
link, enters their own name and number, and the request just sits as
`pending` in the new `transfer_requests` table. Nothing is sent yet.
The owner sees a "so-and-so wants your X" card at the top of their home
screen (or the organiser sees the same request on `/admin`, as a
fallback approver) and has to tap Approve before an OTP even goes out.
Reject and the request just dies. This means a transfer via claim link
needs both an approval from someone who actually knows the receiver
*and* the receiver proving they hold that WhatsApp number -- two
different kinds of trust, not one doing double duty.

Claim links only work for a pass' **first-ever transfer**
(`member_passes.transfer_count === 0`). After that first hand-off, later
transfers just use the plain number + OTP flow -- no approval step, no
"copy claim link" button. The idea is that the one hand-off worth
double-checking is the first one out of the organiser-allotted holder;
requiring every subsequent owner to sit through an approval queue too
would just be busywork with no real security benefit. This is enforced
in both places: the app only shows "Copy claim link" when
`transfersUsed === 0`, and the server independently re-checks it in
`isFirstTransferEligible()` (in `POST /api/claim/:passId/request` and
again at approval time), so someone can't work around the UI by hitting
the API directly.

**Every coupon is day-specific -- the earlier "combined" mode has been
removed.** There's no manual "add pass type" form, and no day-mode
switch either any more -- `ensureEntryCouponPassTypes()` in `server.js`
auto-creates one Entry Coupon pass type per day of the event (Day 1 / Day
2 / Day 3, windows split evenly across the event's dates) the moment
`/admin` loads, if they don't exist yet. An earlier version also offered
a "combined -- one coupon valid across every day" mode; it's gone on
purpose. This project's passes are single-use the instant they're
scanned once (there's no per-day re-entry tracking), so a combined pass
would have incorrectly locked a genuine multi-day holder out after their
very first day's entry -- day-specific coupons don't have that problem,
since each day's coupon is independently single-use, exactly like a real
multi-day wristband. If you're upgrading an install that has old
`general`-category passes from before this change, they keep working
(read paths still recognize `general`) but nothing issues new ones.
"VIP" and "Additional benefit" are no longer pass-type categories at all
-- VIP is a member-level flag (below), and Additional Benefit
(meal/parking-style extras) is parked for now: the schema still allows
the `extra` category, nothing in the UI creates one currently.

**Quantity + day checkboxes, not a raw pass-type checklist.** Every
member-add form (admin single-add, admin bulk, and an allotter's own
page) now asks for a *number of coupons* plus which day(s) each unit
covers, instead of one checkbox per individual pass-type row. The day
checkboxes come pre-checked (every currently active day), so it's not
possible to accidentally submit having selected nothing -- and the
server independently re-validates this (`selectedDayCategories()` +
an explicit empty check in every `/admin/members*` and
`/allot/:token/members*` route), redirecting back with
`?error=no_days_selected` and creating nobody if it happens anyway. This
also made "give Rahul 16 coupons" a single quantity field instead of 16
separate name+number submissions -- see "Coupon requests" below for the
fully self-service version of that.

**The event-wide transfer rule is one setting, and can be locked.**
`events.transfer_limit` (how many times any coupon can be re-transferred
after its first hand-off) is set once from `/admin` → "Event pass
structure" and applied retroactively to every currently active Entry
Coupon (`applyTransferLimit()`), so it can't quietly end up different
across coupons created at different times. "Publish event" sets
`events.published = 1`, which locks that form (both in the UI and
server-side in `POST /admin/transfer-limit`) so the rule can't be
casually re-decided once real coupons are already out in the world --
"Unpublish" clears it to go back to editing. Adding members, allotters,
sponsors, and running the lucky reveal all still work while published.

**VIP is a per-member flag, not a pass category.** Admin's "Add one
member" / "Bulk allotment" forms have a "Mark as VIP" checkbox that sets
`members.is_vip` directly on that member -- it never comes from, or
travels with, any particular coupon they hold. This matters for
transfers: if a VIP-flagged sponsor sends one of their coupons to someone
else, the receiver is looked up/created as a completely separate member
row with their own (default `0`) `is_vip` flag -- they get a perfectly
normal coupon, no VIP status, and the sender's own VIP flag is untouched.
`GET /api/members/:id/summary` returns `member.isVip`, and the member app
shows it once, next to the member's name (`renderAccountAndDrawer()` /
the greet-name badge in `public_app/index.html`) -- not repeated per
coupon card. Only the organiser's own admin forms can set this;
authorized allotters and the self-service request flow below never can.
An existing install upgrades safely: a one-time migration in `lib/db.js`
backfills `is_vip=1` for anyone who was already holding a pass under the
old `vip` category.

**Lucky Coupon eligibility is live, not fixed at creation.** A member is
eligible only while they currently hold **2 or more** complete entry
admissions (`countPersonEquivalents()` in `server.js` -- one "general"
coupon counts as one admission; in per-day mode it takes one of *every*
defined day to count as one complete set, so it takes the smallest
per-day count they hold). This is re-checked on every
`/api/members/:id/summary` call, not decided once when the member is
created -- so someone who transfers coupons away down to just their own
single one loses their Lucky Coupon immediately (the whole "Grand
Finale" section disappears from their app, not just "not revealed yet"),
and someone freshly given a 2nd coupon gains it. A `lucky_coupons` row is
created lazily the first time a member is found eligible
(`getLuckyForMember()`), and `POST /admin/reveal-now` (or the JSON
equivalent, `POST /api/admin/lucky/:eventId/reveal`) first calls
`ensureLuckyRowsForAllEligible()` to catch anyone eligible who never
happened to open their app yet, then assigns a prize to every unrevealed
row at once -- so it genuinely unlocks for everyone at the same moment.
The `/admin` page also has a separate form for the human-readable *rule*
members see beforehand (e.g. "revealed once the closing set ends") --
that's stored in `reveal_rules.rule_note` and returned to the app as
`luckyRule`, so it's not just a hardcoded string in the frontend. Note
that "reveal time" is informational text only -- there's no scheduled
job watching the clock; the actual reveal only happens when the
organiser presses "Reveal Lucky Coupons now" on `/admin` (or hits the
equivalent `POST /api/admin/lucky/:eventId/reveal`), so time it to
whatever the on-stage announcement moment actually is.

Because eligibility is live, `GET /api/members/:id/summary` also flags
each currently-held entry coupon with `couldLoseLucky: true` whenever
that member is *currently* eligible and sending **that specific** coupon
away would drop them below the 2-admission threshold. The member app's
transfer sheet (`openTransfer()` in `public_app/index.html`) shows a
warning banner using this flag before the "Send verification code"
button, so someone doesn't lose their Grand Finale entry by surprise --
they can still go ahead if they mean to.

**Pass allotment.** `/admin` has "Add one member" and "Bulk allotment"
forms. This is an invite/allotment model -- the organiser creates each
member (one at a time, or by pasting a `Name,WhatsApp` list) and picks a
quantity + day(s); a working `/app/<id>` link exists the moment that
form submits. There's no payment gateway wired in (this project never
handles real money movement) -- if you want a public, self-serve "buy a
pass" page, put a payment gateway (Razorpay, Instamojo, etc.) in front
of `POST /admin/members`; it's exactly what that page would call once
payment succeeds. Bulk allotment is safe to re-submit: pasting a list
that includes people already added skips them (counted separately as
"already exists" rather than "blank") instead of re-issuing them another
round of coupons the way an earlier version of this form did when you
pasted the same list twice.

**Allotment access (authorized allotters).** For a big first batch (say
2000 attendees), the organiser usually doesn't want to be the only one
typing names in -- but handing out full `/admin` access to helpers is
too much risk (they'd also see sponsors, coupon setup, the lucky reveal,
etc.). The "Allotment access" section on `/admin` lets the organiser
authorize specific trusted people by name (with an optional WhatsApp
number, just for the organiser's own reference) and generates, per
person: an unguessable link (`/allot/:token`, same style of random-token
link already used for `/app/:memberId` and `/claim/:passId`) that opens a
stripped-down page with *only* the member-add forms and their own pending
coupon requests -- nothing else on `/admin` is reachable from it -- plus a
short, spoken-aloud-friendly numeric `code` (e.g. `23`, auto-generated,
unique) that's separate from that private link, used only to route
self-service coupon requests (below) to this specific person. Every
member created this way is tagged in `members.allotted_by` with the
allotter's name, so the organiser's "Recent members" table always shows
who actually onboarded each attendee (with a live coupon count per
member, in both that table and each allotter's own "People you've
added" table) -- and an allotter's own page only ever queries
`WHERE allotted_by = <their own name>`, so it only ever shows people
*they* added, never another allotter's list. If a helper's access needs
to stop (they're done for the day, or their link leaked), hitting
"Revoke" on `/admin` deletes the `allotters` row -- both the link and
the code stop working immediately. This is deliberately scoped to
*first-time onboarding* only, not an admin role; once a member has their
pass, any further transfer of it goes through the normal owner-to-owner
transfer/claim-link flow above, not through an allotter.

Two more permissions are set per allotter when authorizing them, both
off by default:

- **`can_single_day`** -- unchecked (the default), the allotter's own
  page shows no day picker at all, and every coupon they issue
  automatically covers *every* currently active day (enforced
  server-side too, not just by hiding the checkboxes). Checked, they get
  the same day-checkbox picker the organiser sees, so they can issue a
  single day's coupon when that's genuinely what's needed.
- **`grants_vip`** -- unchecked (the default), no VIP checkbox is shown
  on their page at all, and their submissions can never set
  `members.is_vip`. Checked, they can mark someone VIP the same way the
  organiser's own forms do.

**Coupon requests (self-service, quantity-based allotment).** Typing in
every recipient by hand doesn't scale once someone needs a double-digit
number of coupons at once (e.g. "I need 16 for my group"). Instead of
that, anyone can open the public `/request` page and submit their own
name, WhatsApp number, how many coupons they need, and the short `code`
of whichever authorized allotter they were told to use -- this creates a
`pass_allotment_requests` row and issues nothing yet. That specific
allotter sees the request (requester's name, number, quantity) on their
own `/allot/:token` page under "Coupon requests waiting on you," with
**one shared note field** and two buttons (Approve / Reject) that both
submit that same field to different endpoints via `formaction` -- an
earlier version showed two separate, identically-labelled note inputs
here, which was confusing about which one to fill in; there's only ever
one now. `/admin` can also approve/reject as a fallback, same pattern
and same single-note-field fix. That note is for the organiser/approver's
own record-keeping **only** -- it's stored in
`pass_allotment_requests.note`, but neither `GET /api/allotment-requests/:id`
(what the requester's own `/request` status page polls) nor that page's
rendering ever surface it to the requester; they only ever see
approved/rejected. Approving creates (or reuses) **one member** -- the
requester themselves -- and allots them that many complete admissions in
one shot (`allotEntryCouponUnits()`: one of every currently-active Entry
Coupon pass type per unit requested, so `quantity=16` with Day 1 + Day 2
defined means 16 of each, always day-specific -- never the old combined
category, even if that's what an earlier build of this request flow
produced). The requester is then notified (mocked, via `lib/notify.js`)
with a link to their own `/app/<memberId>`, where all their coupons show
up as ordinary cards -- they hand individual ones to their group
afterwards using the normal transfer/claim-link flow already described
above, exactly like any other member would. Nobody but the organiser's
own forms can set the VIP flag through this path.

**Sponsor detail.** Tapping any sponsor badge in the member app (title,
"powered by", or category-partner) opens a sheet with their tagline and,
if the organiser filled them in on `/admin`, a "Visit website" and/or
"Contact" button (a `wa.me` link, `mailto:`, or any URL). Logos are
optional too -- `/admin`'s sponsor form has a file picker that reads the
image client-side and stores it as a data URI (`sponsors.logo_data_uri`),
so no separate file-upload endpoint or static file server was needed.
Real events often have more than one Title-tier ("co-presenting")
sponsor -- the app renders every Title sponsor as its own full card
instead of only the first, so a second one you add on `/admin` actually
shows up (an earlier version of this app only rendered `title[0]`).

**Pass cards show no text tags at all any more.** Since VIP moved to being
a member-level flag (shown once, near the member's name -- see above),
coupon cards themselves never carry a text badge -- not "VIP," not "Day
1," not "General," nothing, just each coupon's icon and title. Day-wise
coupons still need to be visually distinguishable at a glance, though, so
`public_app/index.html` keeps that distinction as a thin colored
left-border accent (matching each day's existing colour token) instead of
a text tag -- a design choice made to preserve the earlier day-colour cue
once per-card tags went away entirely; if a different visual treatment is
wanted (no accent either, a different colour, a small dot, etc.) it's a
quick change in `cardHTML()` in `public_app/index.html`.

## What's mocked vs. real

| Piece | Status |
|---|---|
| QR generation & signing | **Real.** Standard QR encoding, HMAC-signed tokens, server-side expiry + single-use enforcement. |
| Time-lock / single-use logic | **Real.** Enforced in `lib/state.js` + the `/verify` route, not just in the UI. |
| WhatsApp OTP delivery | **Mocked.** `lib/notify.js` logs the code instead of sending it; the API response includes the code directly (clearly marked `devNote`) so you can test the flow. Swap in Meta Cloud API / Gupshup / Twilio per the comments in that file -- nothing else needs to change. |
| Admin panel | **Minimal.** Functional forms for sponsors, member/pass allotment (single + bulk), allotter and gate-scanner-device authorization, the transfer-rule/publish lock, and the lucky reveal; no auth, no styling polish. Add a login before exposing this beyond your own laptop. |
| Gate-scanner device authorization | **Real.** A cookie set by opening `/scan/:deviceToken` once is genuinely required by `/verify/:token` and `/staff`; there's no login screen behind it, but an unauthorized browser is actually refused, not just hidden from a menu. |
| Pass sale / allotment | **Allotment is real; paid sale is not built.** Organiser-driven creation of members + passes (one at a time, bulk-pasted, via scoped `/allot/:token` helper links, or the self-service `/request` + approval flow) works end to end and issues a real link immediately. No payment gateway is wired in -- see "Pass allotment" above for where one would plug in. |
| Coupon-request WhatsApp notification | **Mocked**, same as OTP delivery -- `lib/notify.js`'s `sendMessage()` logs "your coupons are ready" instead of sending it. Swap the transport the same way as `sendOtp()`. |
| Multi-event / multi-organiser support | **Not yet.** The schema has an `events` table, but routes assume a single event (`SELECT * FROM events LIMIT 1` in a few places). Straightforward to extend once you're ready for multiple organisers. |
| Customer-facing app | **Real and connected.** `public_app/index.html`, served at `/app/<memberId>`, is the full member UI (VIP tag, day-colour accordions, sponsor tiers, transfer sheet, Lucky Coupon) wired to the live APIs above -- not the standalone mock. There's a separate pure-frontend interactive prototype (with a fake simulated clock, for quickly previewing every visual state) that is intentionally *not* wired to this backend; this one is the real thing. |

## Project layout

```
server/
  server.js            entry point + all routes
  public_app/
    index.html         the real member-facing app, served at /app/:memberId
  lib/
    db.js              schema + demo seed data (node:sqlite)
    state.js           locked/active/used/expired logic (single source of truth)
    token.js           HMAC-signed, time-bound QR tokens
    qr.js              token/URL -> QR SVG
    qrencoder/          vendored MIT QR algorithm (see NOTICE.md there)
    notify.js          WhatsApp OTP -- mocked, swap for a real provider
    pages.js           the server-rendered HTML pages (verify/staff/admin/claim/allot/request)
    router.js          minimal http router (no Express)
  data/                sqlite file lives here (gitignore this in your own repo)
```

## Bug fixes from an internal audit

A full re-read of the transfer, allotment, and lucky-draw logic (prompted by
a "where might this still be wrong" review) turned up five real issues,
all now fixed:

- **Transfer double-spend.** `/api/transfer/initiate` and
  `/api/transfer/confirm` didn't check whether a pass was still genuinely
  `active` before minting a hand-off. Initiating two transfers against the
  same pass before confirming either used to let both complete, turning
  one coupon into two independent active passes (or reviving an
  already-scanned "used" pass into a fresh one for someone else). Both
  routes now re-check live status; the second confirm of a double-initiate
  is correctly refused with `pass_no_longer_available`.
- **Revoking an active allotter crashed.** `pass_allotment_requests.approver_id`
  is a `NOT NULL` foreign key with no `ON DELETE` clause, so hard-deleting
  an allotter who'd ever received a single coupon request (pending,
  approved, or rejected) threw a raw FOREIGN KEY constraint error instead
  of revoking -- exactly the allotters most likely to need revoking.
  `allotters` now has a `revoked` flag; "Revoke" sets it instead of
  deleting the row, so their token/code stop working immediately without
  touching request history.
- **Lucky-eligibility math undercounted requirements.** A member holding
  *only* Day-1 coupons (e.g. from a `can_single_day` allotter) was
  incorrectly counted as eligible with `quantity >= 2`, even with zero
  Day-2 coupons -- the "one of every currently-defined day" rule only
  looked at categories the member happened to hold, not every day the
  event actually has. Fixed to check every active day category, defaulting
  a missing one to 0.
- **Single-add form could double-issue coupons.** Bulk allotment already
  skipped re-issuing to an already-existing WhatsApp number on a re-paste;
  the single "Add one member" form (both `/admin` and an allotter's own
  page) didn't have the same guard, so a double-click or stale
  back-button resubmit silently minted another full `quantity` batch. Now
  gated the same way, with a clear "already has an account, nothing
  issued" message instead of silent duplication.
- **A blank/whitespace-only name or WhatsApp number** used to slip past
  the old `b.name || 'New Member'` fallback (which only catches an empty
  string, not `" "`), creating an unreachable member with a blank name.
  Both single-add routes now reject this outright.

## Security notes before going live

- Set `GATEPASS_SECRET` to a long random value via environment variable
  in production -- `lib/token.js` falls back to a dev placeholder.
- Put `/admin` behind real authentication. This also protects the
  "Emergency override" verify form and the ability to authorize new
  gate-scanner devices, both of which currently rely on `/admin` itself
  being an unguessable/private link, same as the rest of this panel.
- Rate-limit `/api/transfer/initiate` (OTP requests) and `/verify/:token`.
- Consider HTTPS termination (a reverse proxy like nginx/Caddy, or your
  host's built-in TLS) -- the OTP and tokens should never travel in the
  clear.
