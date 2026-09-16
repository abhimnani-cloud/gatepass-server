// Small server-rendered HTML pages: the gate verify result, the staff
// manual-entry fallback, and the organiser admin/config screen. Deliberately
// plain (no build step, no client framework) since these are internal /
// staff-facing tools, not the member-facing app.

const BASE_STYLE = `
  :root{color-scheme:light dark; --ink:#1B2023; --bg:#FBF7EE; --line:#E4DEC9; --accent:#B8892B; --good:#3F7D4C; --bad:#B24A3E;}
  @media (prefers-color-scheme:dark){:root{--ink:#F3EEE1; --bg:#12181B; --line:#2A3338; --accent:#DDB35C;}}
  *{box-sizing:border-box;}
  body{font-family:-apple-system,system-ui,sans-serif; background:var(--bg); color:var(--ink); margin:0; padding:32px 20px;}
  .wrap{max-width:520px; margin:0 auto;}
  h1{font-size:1.3rem; margin:0 0 6px;}
  h2{font-size:1.05rem; margin:28px 0 10px;}
  p{line-height:1.5; color:inherit;}
  a{color:var(--accent);}
  code{background:var(--line); padding:2px 6px; border-radius:6px; font-size:0.85em;}
  .card{background:color-mix(in srgb, var(--line) 35%, transparent); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:14px;}
  .status{display:flex; align-items:center; gap:12px; font-size:1.15rem; font-weight:700;}
  .dot{width:14px;height:14px;border-radius:50%;}
  .dot.good{background:var(--good);} .dot.bad{background:var(--bad);}
  input,select,textarea,button{font:inherit; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; width:100%;}
  label{display:block; font-size:0.82rem; margin:10px 0 4px; opacity:0.8;}
  button{background:var(--accent); color:#20180A; font-weight:700; border:none; cursor:pointer; margin-top:14px;}
  table{width:100%; border-collapse:collapse; font-size:0.88rem;}
  td,th{text-align:left; padding:6px 4px; border-bottom:1px solid var(--line);}

  /* Collapsible top-level admin sections -- native <details>, no JS required
     to work at all; a small script further down only adds "remember which
     ones I had open" across page reloads. */
  details.admin-section{margin-bottom:10px;}
  details.admin-section > summary{
    cursor:pointer; list-style:none; font-size:1.05rem; font-weight:700; padding:12px 2px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    border-bottom:2px solid var(--line);
  }
  details.admin-section > summary::-webkit-details-marker{display:none;}
  details.admin-section > summary .chev{font-size:0.8rem; opacity:0.5; transition:transform 0.15s; flex:0 0 auto;}
  details.admin-section[open] > summary .chev{transform:rotate(90deg);}
  .section-body{padding-top:14px;}

  /* Same toggle idea, smaller -- one row per sponsor / allotter, expanding
     into an edit form instead of a separate page. */
  details.mini{border:1px solid var(--line); border-radius:12px; margin-bottom:8px; overflow:hidden; background:color-mix(in srgb, var(--line) 15%, transparent);}
  details.mini > summary{cursor:pointer; list-style:none; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:0.92rem;}
  details.mini > summary::-webkit-details-marker{display:none;}
  details.mini > summary .chev{font-size:0.75rem; opacity:0.5; transition:transform 0.15s; flex:0 0 auto;}
  details.mini[open] > summary .chev{transform:rotate(90deg);}
  .mini-body{padding:0 12px 14px; border-top:1px solid var(--line); padding-top:12px;}
`;

function pageShell(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>${BASE_STYLE}</style></head>
  <body><div class="wrap"><h1>${title}</h1>${bodyHtml}</div></body></html>`;
}

function verifyResultPage(success, message) {
  return pageShell('Gate check', `
    <div class="card">
      <div class="status">
        <span class="dot ${success ? 'good' : 'bad'}"></span>
        <span>${success ? 'Entry granted' : 'Not valid'}</span>
      </div>
      <p>${message}</p>
    </div>
    <p><a href="/staff">Enter a code manually instead</a></p>
  `);
}

function adminLoginPage(error) {
  return pageShell('Organiser login', `
    ${error ? '<div class="card" style="border-color:var(--bad);"><p style="margin:0;color:var(--bad);">Wrong password -- try again.</p></div>' : ''}
    <p>Enter the organiser password to open the admin panel.</p>
    <form method="POST" action="/admin/login">
      <label>Password</label>
      <input type="password" name="password" required autofocus>
      <button type="submit">Log in</button>
    </form>
  `);
}

function staffPage() {
  return pageShell('Manual gate check', `
    <p>Paste the code from a member's coupon (or the full link) if the camera can't scan it.</p>
    <form method="POST" action="/staff/verify">
      <label>Verification token</label>
      <input name="token" placeholder="paste token here" required>
      <button type="submit">Check</button>
    </form>
  `);
}

function toDatetimeLocal(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// One collapsible top-level block on /admin. defaultOpen sets its state on
// a brand-new visit; forceOpen overrides that (and any remembered
// preference) for one page load only -- used right after an action inside
// that section, so the confirmation/error is never hidden behind a
// collapsed header the visitor has to go find.
function section(key, title, bodyHtml, opts) {
  opts = opts || {};
  const open = opts.forceOpen || opts.defaultOpen;
  return `<details class="admin-section" data-key="${key}"${opts.forceOpen ? ' data-force-open="1"' : ''}${open ? ' open' : ''}>
    <summary><span>${title}</span><span class="chev">▸</span></summary>
    <div class="section-body">${bodyHtml}</div>
  </details>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tierOptionsHtml(selected) {
  const opts = [
    ['title', 'Title sponsor (co-presented by)'],
    ['associate', 'In association with'],
    ['powered', 'Powered by'],
    ['partner', 'Supported by'],
  ];
  return opts.map(([v, label]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function adminPage({ event, sponsors, passTypes, rule, sampleMemberId, memberCount, recentMembers, pendingRequests, pendingAllotmentRequests, allotters, scannerDevices, baseUrl, flash, luckyDrawEnabled, passStats, passStatsByDay, transferHistory }) {
  passStats = passStats || { totalAllotted: 0, active: 0, used: 0, totalTransfers: 0 };
  passStatsByDay = passStatsByDay || [];
  transferHistory = transferHistory || [];
  flash = flash || {};
  pendingRequests = pendingRequests || [];
  pendingAllotmentRequests = pendingAllotmentRequests || [];
  allotters = allotters || [];
  scannerDevices = scannerDevices || [];
  baseUrl = baseUrl || '';
  const tierLabel = { title: 'Title', associate: 'In association with', powered: 'Powered by', partner: 'Supported by' };
  const published = !!event.published;
  const categoryDisplay = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3', general: 'All days (legacy)' };
  const dayCategories = passTypes.filter((p) => p.category === 'day1' || p.category === 'day2' || p.category === 'day3').map((p) => p.category);

  // Each sponsor is its own collapsible mini row that expands straight into
  // an edit form (same fields as "add"), pre-filled with its current
  // values -- fixing a wrong URL/number, or swapping a logo, no longer
  // means delete-and-recreate (which would also lose its position).
  // Leaving the file picker empty on save keeps whatever logo it already had.
  const sponsorRows = sponsors
    .map((s) => {
      const editId = `sponsor-logo-data-${s.id}`;
      return `<details class="mini">
        <summary>
          <span style="display:flex; align-items:center; gap:8px; min-width:0;">
            ${s.logo_data_uri ? `<img src="${s.logo_data_uri}" alt="" style="width:26px;height:26px;border-radius:6px;object-fit:cover;flex:0 0 auto;">` : ''}
            <strong style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(s.name)}</strong>
          </span>
          <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
            <span style="opacity:0.65; font-size:0.78em; white-space:nowrap;">${tierLabel[s.tier] || s.tier}</span>
            <span class="chev">▸</span>
          </span>
        </summary>
        <div class="mini-body">
          <form method="POST" action="/admin/sponsors/${s.id}/edit">
            <label style="margin-top:0;">Name</label><input name="name" value="${esc(s.name)}" required>
            <label>Tier</label>
            <select name="tier">${tierOptionsHtml(s.tier)}</select>
            <label>Tagline (shown when a member taps this sponsor)</label>
            <input name="tagline" value="${esc(s.tagline || '')}" placeholder="e.g. Official food court partner">
            <label>Website link (optional)</label>
            <input name="website_url" type="url" value="${esc(s.website_url || '')}" placeholder="https://...">
            <label>Contact link (optional -- WhatsApp, phone, or email)</label>
            <input name="contact_url" value="${esc(s.contact_url || '')}" placeholder="https://wa.me/9198... or mailto:you@brand.com">
            <label>Replace logo (optional -- leave blank to keep the current one)</label>
            <input type="file" class="logo-file-input" data-target="${editId}" accept="image/*">
            <input type="hidden" name="logo_data_uri" id="${editId}">
            <button type="submit">Save changes</button>
          </form>
          <form method="POST" action="/admin/sponsors/${s.id}/delete" style="margin-top:10px;" onsubmit="return confirm('Remove ${esc(s.name).replace(/'/g, '')}?');">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Remove sponsor</button>
          </form>
        </div>
      </details>`;
    })
    .join('');

  const passRows = passTypes
    .map(
      (p) =>
        `<tr><td>${p.icon || '🎟️'} ${esc(p.title)}</td><td>${categoryDisplay[p.category] || p.category}</td><td style="font-family:monospace; font-size:0.78rem;">${new Date(p.window_start).toLocaleString()} – ${new Date(p.window_end).toLocaleString()}</td></tr>`
    )
    .join('');

  // Quantity + which day(s) instead of a raw pass-type checklist -- days
  // come pre-checked (all of them) so it's impossible to submit having
  // accidentally picked none; the server double-checks this too.
  function dayCheckboxes(idPrefix) {
    return dayCategories.map((cat) => `<label style="display:flex; align-items:center; gap:8px; font-size:0.86rem; margin:6px 0;">
        <input type="checkbox" name="day_${cat}" id="${idPrefix}_${cat}" checked style="width:auto;"> ${categoryDisplay[cat] || cat} Entry Coupon
      </label>`).join('');
  }

  // Same mini-row-with-inline-form idea as sponsors/allotters -- fixing a
  // typo, cancelling one wrongly-issued coupon, or removing the whole
  // member outright, all without leaving the Members section.
  const memberRows = (recentMembers || [])
    .map((m) => {
      const activePasses = m.activePasses || [];
      const cancelRows = activePasses
        .map((p) => `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--line);">
          <span style="font-size:0.85rem;">${categoryDisplay[p.category] || p.category} -- ${esc(p.title)}</span>
          <form method="POST" action="/admin/member-passes/${p.id}/cancel" style="margin:0; width:auto;" onsubmit="return confirm('Cancel this coupon? This can\\'t be undone.');">
            <button type="submit" style="width:auto; padding:4px 10px; margin:0; font-size:0.78rem; background:transparent; color:var(--bad); border:1px solid var(--bad);">Cancel</button>
          </form>
        </div>`)
        .join('');
      return `<details class="mini">
        <summary>
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <strong>${esc(m.name)}</strong>${m.is_vip ? ' <span class="tag" style="background:var(--accent); color:#20180A; padding:1px 6px; font-size:0.72rem;">VIP</span>' : ''}
          </span>
          <span style="display:flex; align-items:center; gap:10px; flex:0 0 auto;">
            <span style="font-size:0.76rem; opacity:0.7; white-space:nowrap;">${m.coupon_count != null ? m.coupon_count : '—'} coupon(s)</span>
            <span class="chev">▸</span>
          </span>
        </summary>
        <div class="mini-body">
          <p style="font-size:0.82rem; opacity:0.8;">${esc(m.whatsapp)}${m.allotted_by ? ' · added by ' + esc(m.allotted_by) : ''}</p>
          <p style="font-size:0.85rem;">Their app: <a href="/app/${m.id}">/app/${m.id}</a></p>
          <form method="POST" action="/admin/members/${m.id}/edit">
            <label style="margin-top:0;">Name</label><input name="name" value="${esc(m.name)}" required>
            <label>WhatsApp number</label><input name="whatsapp" value="${esc(m.whatsapp)}" required>
            <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
              <input type="checkbox" name="is_vip" style="width:auto;" ${m.is_vip ? 'checked' : ''}> Mark as VIP
            </label>
            <button type="submit" style="width:auto; margin-top:12px;">Save changes</button>
          </form>
          ${activePasses.length ? `<div style="margin-top:14px;">
            <p style="font-size:0.82rem; opacity:0.75; margin:0 0 4px;">Currently active coupons -- cancel one if it was issued by mistake (already-used or already-transferred coupons can't be cancelled here):</p>
            ${cancelRows}
          </div>` : `<p style="font-size:0.8rem; opacity:0.65; margin-top:14px;">No active coupons left to cancel.</p>`}
          <form method="POST" action="/admin/members/${m.id}/delete" style="margin-top:14px;" onsubmit="return confirm('Remove ${esc(m.name).replace(/'/g, '')} entirely? All their coupons go with them -- this can\\'t be undone.');">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Remove this member entirely</button>
          </form>
        </div>
      </details>`;
    })
    .join('');

  // Same mini-row-with-inline-form idea as sponsors above -- an allotter's
  // cap, their own "who have they added" list, and revoking them, all
  // inside one expandable row instead of a flat table + a separate section.
  const allotterRows = allotters
    .map((a) => {
      const cap = a.max_allotments;
      const used = a.allotted_count || 0;
      const capLabel = cap != null ? `${used} / ${cap} allotted` : `${used} allotted · no limit`;
      const addedMembers = a.addedMembers || [];
      const addedRows = addedMembers
        .map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.whatsapp)}</td><td style="text-align:center;">${m.coupon_count != null ? m.coupon_count : '—'}</td><td><a href="/app/${m.id}">/app/${m.id}</a></td></tr>`)
        .join('');
      return `<details class="mini">
        <summary>
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <strong>${esc(a.name)}</strong>
            <span style="font-family:monospace; opacity:0.7; margin-left:8px;">code ${esc(a.code || '—')}</span>
          </span>
          <span style="display:flex; align-items:center; gap:10px; flex:0 0 auto;">
            <span style="font-size:0.76rem; opacity:0.7; white-space:nowrap;">${capLabel}</span>
            <span class="chev">▸</span>
          </span>
        </summary>
        <div class="mini-body">
          <p style="font-size:0.82rem; opacity:0.8;">${a.can_single_day ? 'Can pick a single day per unit' : 'Always issues every currently active day'}${a.grants_vip ? ' · can mark VIP' : ''}${a.whatsapp ? ' · ' + esc(a.whatsapp) : ''}</p>
          <p style="word-break:break-all; font-size:0.85rem;">Their link: <a href="/allot/${a.token}">${baseUrl}/allot/${a.token}</a></p>
          <form method="POST" action="/admin/allotters/${a.id}/limit" style="display:flex; gap:8px; align-items:flex-end;">
            <div style="flex:1; min-width:0;">
              <label style="margin-top:0;">Allotment limit (blank = unlimited)</label>
              <input name="max_allotments" type="number" min="0" value="${cap != null ? cap : ''}" placeholder="no limit">
            </div>
            <button type="submit" style="width:auto; margin-top:0;">Update</button>
          </form>
          ${addedRows
            ? `<details style="margin-top:12px;"><summary style="cursor:pointer; font-size:0.85rem; list-style:none;">▸ Members added by ${esc(a.name)} (${addedMembers.length})</summary>
              <table style="margin-top:8px;"><tr><th>Name</th><th>WhatsApp</th><th>Coupons</th><th>Link</th></tr>${addedRows}</table>
            </details>`
            : `<p style="font-size:0.8rem; opacity:0.65; margin-top:12px;">Hasn't added anyone yet.</p>`}
          <form method="POST" action="/admin/allotters/${a.id}/delete" style="margin-top:12px;" onsubmit="return confirm('Revoke access for ${esc(a.name).replace(/'/g, '')}?');">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Revoke</button>
          </form>
        </div>
      </details>`;
    })
    .join('');

  const scannerDeviceRows = scannerDevices
    .map((d) => `<tr>
        <td>${esc(d.name)}</td>
        <td style="word-break:break-all;"><a href="/scan/${d.token}">${baseUrl}/scan/${d.token}</a></td>
        <td>
          <form method="POST" action="/admin/scanner-devices/${d.id}/delete" style="margin:0;" onsubmit="return confirm('Revoke this device? It will stop being able to scan immediately.');">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Revoke</button>
          </form>
        </td>
      </tr>`)
    .join('');

  const pendingAllotmentCards = pendingAllotmentRequests
    .map(
      (r) => `<div class="card">
        <p style="margin-top:0;"><strong>${esc(r.requester_name)}</strong> wants <strong>${r.quantity}</strong> coupon(s), routed to approver <strong>${esc(r.approver_name)}</strong></p>
        <p style="font-size:0.85rem; opacity:0.8; margin-top:-8px;">${esc(r.requester_whatsapp)}</p>
        <form data-note-form>
          <label>Note (optional, kept on record -- not shown to the requester)</label>
          <input type="text" name="note" placeholder="e.g. Confirmed with team lead">
          <div style="display:flex; gap:8px; margin-top:14px;">
            <button type="submit" formmethod="POST" formaction="/admin/allotment-requests/${r.id}/approve" style="margin-top:0;">Approve</button>
            <button type="submit" formmethod="POST" formaction="/admin/allotment-requests/${r.id}/reject" style="margin-top:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Reject</button>
          </div>
        </form>
      </div>`
    )
    .join('');

  let flashHtml = '';
  if (flash.added) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Member added. Their link: <a href="/app/${flash.added}">/app/${flash.added}</a></p></div>`;
  } else if (flash.existing) {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ That WhatsApp number already has an account -- no new coupons were issued (to avoid handing out duplicates on a re-submit). Their existing link: <a href="/app/${flash.existing}">/app/${flash.existing}</a></p></div>`;
  } else if (flash.bulkCreated != null) {
    const blank = Number(flash.bulkBlank) || 0;
    const duplicate = Number(flash.bulkDuplicate) || 0;
    const limitBlocked = Number(flash.bulkLimitBlocked) || 0;
    let skipNote = '';
    if (blank || duplicate || limitBlocked) {
      const parts = [];
      if (blank) parts.push(`${blank} blank line(s)`);
      if (duplicate) parts.push(`${duplicate} already-existing WhatsApp number(s) -- no duplicate coupons were issued to them`);
      if (limitBlocked) parts.push(`${limitBlocked} that would have gone over the allotment limit`);
      skipNote = ` ${parts.join(', ')} skipped.`;
    }
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Bulk allotment done -- ${flash.bulkCreated} member(s) created.${skipNote} See the table below for their links.</p></div>`;
  } else if (flash.error === 'missing_details') {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Nothing was added -- name and WhatsApp number can't be blank (or just spaces). Try again below.</p></div>`;
  } else if (flash.error === 'no_days_selected') {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Nothing was added -- at least one day must stay checked (or the quantity must be 1 or more). Try again below.</p></div>`;
  } else if (flash.error === 'limit_exceeded') {
    const remaining = flash.remaining != null ? Number(flash.remaining) : 0;
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Could not approve -- this approver only has ${remaining} coupon(s) left under their allotment limit. Raise their limit in "Allotment access" below, or approve a smaller quantity.</p></div>`;
  } else if (flash.error === 'whatsapp_taken') {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Could not save -- that WhatsApp number already belongs to a different member. Double-check it and try again.</p></div>`;
  } else if (flash.error === 'coupon_not_cancellable') {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ That coupon can't be cancelled -- it's already been used at the gate or has already moved on to someone else.</p></div>`;
  } else if (flash.eventSaved) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Event details saved.</p></div>`;
  } else if (flash.sponsorAdded) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Sponsor added.</p></div>`;
  } else if (flash.sponsorEdited) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Sponsor updated.</p></div>`;
  } else if (flash.allotterAdded) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ New allotter authorized -- their link is below.</p></div>`;
  } else if (flash.limitUpdated) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Allotment limit updated.</p></div>`;
  } else if (flash.memberEdited) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Member details updated.</p></div>`;
  } else if (flash.couponCancelled) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Coupon cancelled.</p></div>`;
  } else if (flash.memberDeleted) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Member removed, along with their coupons.</p></div>`;
  }

  // Which section should force itself open (overriding any remembered
  // collapsed state) because the flash message above refers to it -- so a
  // confirmation/error is never hidden behind a header the visitor has to
  // go find.
  const forceEventDetails = !!flash.eventSaved;
  const forceMembers = !!(flash.added || flash.existing || flash.bulkCreated != null || flash.error === 'missing_details' || flash.error === 'no_days_selected' || flash.error === 'whatsapp_taken' || flash.error === 'coupon_not_cancellable' || flash.memberEdited || flash.couponCancelled || flash.memberDeleted);
  const forceSponsors = !!(flash.sponsorAdded || flash.sponsorEdited);
  const forceAllotters = !!(flash.allotterAdded || flash.limitUpdated);
  const forcePendingCoupon = flash.error === 'limit_exceeded';

  const pendingRows = pendingRequests
    .map(
      (r) => `<tr>
        <td>${esc(r.requester_name)}<br><span style="opacity:0.65; font-size:0.8em;">${esc(r.requester_whatsapp)}</span></td>
        <td>${esc(r.pass_title)}<br><span style="opacity:0.65; font-size:0.8em;">owned by ${esc(r.owner_name)}</span></td>
        <td style="white-space:nowrap;">
          <form method="POST" action="/admin/transfer-requests/${r.id}/approve" style="display:inline; margin:0;">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0;">Approve</button>
          </form>
          <form method="POST" action="/admin/transfer-requests/${r.id}/reject" style="display:inline; margin:0;">
            <button type="submit" style="width:auto; padding:5px 10px; margin:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Reject</button>
          </form>
        </td>
      </tr>`
    )
    .join('');

  const dayStatsRows = passStatsByDay
    .map((r) => `<tr>
      <td>${categoryDisplay[r.category] || r.category}</td>
      <td style="text-align:center;">${r.totalAllotted}</td>
      <td style="text-align:center;">${r.active}</td>
      <td style="text-align:center;">${r.used}</td>
    </tr>`)
    .join('');

  const dashboardBody = `
    <div class="card">
      <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:16px;">
        <div style="text-align:center; padding:10px; border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:1.4rem; font-weight:700;">${passStats.totalAllotted}</div>
          <div style="font-size:0.72rem; opacity:0.75;">Total coupons allotted</div>
        </div>
        <div style="text-align:center; padding:10px; border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:1.4rem; font-weight:700;">${passStats.active}</div>
          <div style="font-size:0.72rem; opacity:0.75;">Currently active (not yet used)</div>
        </div>
        <div style="text-align:center; padding:10px; border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:1.4rem; font-weight:700;">${passStats.used}</div>
          <div style="font-size:0.72rem; opacity:0.75;">Used / checked in at gate</div>
        </div>
        <div style="text-align:center; padding:10px; border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:1.4rem; font-weight:700;">${passStats.totalTransfers}</div>
          <div style="font-size:0.72rem; opacity:0.75;">Total transfers done</div>
        </div>
      </div>
      ${dayStatsRows ? `
      <h3 style="font-size:0.9rem; margin:0 0 8px;">Per-day breakdown</h3>
      <table style="margin-bottom:16px;"><tr><th>Day</th><th style="text-align:center;">Allotted</th><th style="text-align:center;">Active</th><th style="text-align:center;">Used</th></tr>${dayStatsRows}</table>
      ` : ''}
      ${transferHistory.length ? `
      <h3 style="font-size:0.9rem; margin:0 0 8px;">Transfer history (most recent first)</h3>
      <table style="margin-bottom:16px;">
        <tr><th>When</th><th>Coupon</th><th>From</th><th>To</th></tr>
        ${transferHistory.map((t) => `<tr>
          <td style="font-size:0.78rem;">${new Date(t.created_at).toLocaleString()}</td>
          <td>${esc(t.pass_title)}</td>
          <td>${esc(t.from_name)}</td>
          <td>${t.to_name ? esc(t.to_name) + ' · ' : ''}${esc(t.to_whatsapp)}</td>
        </tr>`).join('')}
      </table>
      ` : `<p style="opacity:0.75; margin-bottom:16px;">No transfers have happened yet -- this fills in the moment a member successfully transfers a coupon to someone else.</p>`}
      <label style="display:flex; align-items:center; gap:8px; margin-top:0;">
        <input type="checkbox" id="auto-refresh-toggle" style="width:auto;"> Auto-refresh this page every 20s (handy while watching the gate live)
      </label>
      ${sampleMemberId
        ? `<p style="margin-bottom:0;">Sample member app: <a href="/app/${sampleMemberId}">/app/${sampleMemberId}</a></p>`
        : `<p style="margin-bottom:0; opacity:0.75;">No members yet -- add one in "Members &amp; coupon allotment" below, and their app link will show here.</p>`}
    </div>
  `;

  const testingBody = `
    <div class="card">
      <p style="margin-top:0;">Real events run on real dates, so coupons normally stay locked for hours/days.
      For quick local testing, this shifts every coupon into an open window right now:</p>
      <form method="POST" action="/admin/testing/open-now">
        <button type="submit">⏩ Open everything now (testing only)</button>
      </form>
      <p style="font-size:0.82rem; opacity:0.7; margin-top:14px; margin-bottom:0;">Emergency single-entry override (for a lost/dead scanner device) lives in "Gate scanner devices" below.</p>
    </div>
  `;

  const sections = [];

  sections.push(section('dashboard', 'Dashboard', dashboardBody, { defaultOpen: true }));

  if (pendingRequests.length) {
    sections.push(section('pending-transfers', `Pending transfer requests (${pendingRequests.length})`, `
      <div class="card">
        <p style="margin-top:0;">Someone opened a coupon owner's <code>/claim/:passId</code> link and asked
        for it. Normally the owner approves this from their own app -- this is the same action from
        the organiser side, for when the owner isn't around or you want oversight on every transfer.</p>
        <table><tr><th>Requester</th><th>Coupon</th><th></th></tr>${pendingRows}</table>
      </div>
    `, { defaultOpen: true }));
  }

  if (pendingAllotmentRequests.length || forcePendingCoupon) {
    sections.push(section('pending-coupons', `Pending coupon requests (${pendingAllotmentRequests.length})`, `
      <p style="font-size:0.85rem; opacity:0.75; margin-top:0;">Someone used the public <a href="/request">/request</a> link with an
      approver's code below. Normally that specific approver reviews this from their own
      <code>/allot/:token</code> page -- this is the same action from here, in case they're not
      around.</p>
      ${pendingAllotmentCards || '<p style="opacity:0.7; font-size:0.85rem;">Nothing pending right now.</p>'}
    `, { defaultOpen: pendingAllotmentRequests.length > 0, forceOpen: forcePendingCoupon }));
  }

  sections.push(section('event-details', 'Event details', `
    <div class="card">
      <p style="margin-top:0;">These edit the live event directly and take effect immediately --
      unlike event.config.js, which only sets the starting values the very first time the server
      is ever run. Existing Day 1/2/3 gate windows are automatically reshaped onto new dates if you
      change them here.</p>
      <form method="POST" action="/admin/event-details">
        <label>Event name</label>
        <input name="name" value="${esc(event.name)}" required>
        <label>Venue</label>
        <input name="venue" value="${esc(event.venue || '')}" placeholder="e.g. Riverside Grounds, Bilaspur">
        <label>Day 1 starts</label>
        <input type="datetime-local" name="start_at" value="${toDatetimeLocal(event.start_at)}">
        <label>Event ends</label>
        <input type="datetime-local" name="end_at" value="${toDatetimeLocal(event.end_at)}">
        <button type="submit">Save event details</button>
      </form>
    </div>
  `, { forceOpen: forceEventDetails }));

  sections.push(section('members', `Members &amp; coupon allotment (${memberCount})`, `
    <div class="card">
      <p style="margin-top:0;">This is an <strong>allotment</strong> model, not a paid checkout: you (the
      organiser) create each member here -- one at a time, or in bulk from a guest list -- and
      they immediately get a working link with the coupons you specify. If you later want a public
      "buy a coupon" page, put a payment gateway in front of these same two forms; they're what it
      would call once payment succeeds. Need to hand out a double-digit number of coupons to one
      person (e.g. a group representative)? The "Allotment access" section below has a faster,
      self-service way to do that without typing in every recipient by hand.</p>

      <h3 style="font-size:0.95rem; margin:18px 0 8px;">Add one member</h3>
      <form method="POST" action="/admin/members">
        <label>Name</label><input name="name" required>
        <label>WhatsApp number</label><input name="whatsapp" placeholder="+91 9xxxxxxxxx" required>
        <label>Number of coupons (sets/units)</label>
        <input name="quantity" type="number" min="1" max="500" value="1" required>
        <label style="margin-top:12px;">Day(s) each unit includes</label>
        ${dayCheckboxes('single')}
        <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
          <input type="checkbox" name="is_vip" style="width:auto;"> Mark as VIP (shows a VIP tag on their profile only -- never travels if they transfer a coupon to someone else)
        </label>
        <button type="submit">Add member &amp; issue coupons</button>
      </form>

      <h3 style="font-size:0.95rem; margin:22px 0 8px;">Bulk allotment</h3>
      <p style="font-size:0.82rem; opacity:0.75; margin-top:-4px;">Same quantity, day(s), and VIP flag apply to
      everyone in this paste. Re-pasting a list that includes people already added is safe -- they're
      skipped, not re-issued extra coupons.</p>
      <form method="POST" action="/admin/members/bulk">
        <label>Paste one "Name,WhatsApp" pair per line (e.g. copied from a spreadsheet)</label>
        <textarea name="csv" rows="5" placeholder="Aman Verma,+919800000001&#10;Riya Shah,+919800000002" required></textarea>
        <label>Number of coupons (sets/units) each person gets</label>
        <input name="quantity" type="number" min="1" max="500" value="1" required>
        <label style="margin-top:12px;">Day(s) each unit includes</label>
        ${dayCheckboxes('bulk')}
        <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
          <input type="checkbox" name="is_vip" style="width:auto;"> Mark everyone in this batch as VIP
        </label>
        <button type="submit">Create all &amp; issue coupons</button>
      </form>

      ${memberRows ? `<h3 style="font-size:0.95rem; margin:22px 0 8px;">Recent members</h3>${memberRows}` : ''}
    </div>
  `, { forceOpen: forceMembers }));

  sections.push(section('allotters', `Allotment access (${allotters.length})`, `
    <div class="card">
      <p style="margin-top:0;">If a handful of trusted people are onboarding attendees in batches
      instead of you doing every single one, add them here. Each gets their own link that can
      <strong>only</strong> add members and issue coupons -- not touch sponsors, coupon setup, or the
      lucky reveal. Every member they add records who added them, and their own page only ever shows
      the people <em>they</em> added, never anyone else's. Give someone a limit if you want to cap how
      much they can hand out on their own -- their row below shows how much they've used, and you can
      raise or lower it any time. Revoke a link any time (e.g. if a number changes or someone stops
      helping); it stops working immediately.</p>
      <p>Anyone needing a batch of coupons (e.g. "I need 16 for my group") can request their own,
      instead of an approver typing each person in one at a time: share this link along with one of
      the codes below --</p>
      <p style="text-align:center; font-size:1.05rem; font-weight:700; margin:10px 0;">${baseUrl}/request</p>
      <p style="font-size:0.82rem; opacity:0.75;">They enter their own name, WhatsApp number, how many
      coupons they need, and the approver's code (e.g. "23") -- that approver then sees the request on
      their own <code>/allot/:token</code> page and can approve (issuing the coupons under the
      requester's own name, which they then redistribute via the normal transfer/claim-link flow) or
      reject it, with an optional note either way. That note is for your own record-keeping -- the
      requester is only ever told approved/rejected, never the note text. A request that would push an
      approver over their own limit is blocked with a clear message instead of silently over-issuing.</p>
      ${allotterRows || '<p style="opacity:0.7; font-size:0.85rem;">No one added yet -- everything goes through the forms above until you add someone here.</p>'}
      <h3 style="font-size:0.95rem; margin:18px 0 8px;">Authorize someone new</h3>
      <form method="POST" action="/admin/allotters">
        <label>Name</label><input name="name" required>
        <label>WhatsApp (optional, just for your own reference)</label><input name="whatsapp" placeholder="+91 9xxxxxxxxx">
        <label>Allotment limit (optional -- how many coupon units they can ever issue; leave blank for unlimited)</label>
        <input name="max_allotments" type="number" min="0" placeholder="no limit">
        <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
          <input type="checkbox" name="can_single_day" style="width:auto;"> Let them choose a single day instead of always issuing all days (if left unchecked, their page won't show a day picker at all -- every coupon they issue auto-includes every currently active day)
        </label>
        <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
          <input type="checkbox" name="grants_vip" style="width:auto;"> Let them mark someone as VIP (if left unchecked, no VIP option shows on their page at all)
        </label>
        <button type="submit">Generate their link &amp; code</button>
      </form>
    </div>
  `, { forceOpen: forceAllotters }));

  sections.push(section('sponsors', `Sponsors (${sponsors.length})`, `
    <div class="card">
      ${sponsorRows || '<p style="opacity:0.7; font-size:0.85rem;">No sponsors yet -- add one below.</p>'}
      <p style="font-size:0.8rem; opacity:0.75; margin-top:14px;">Every sponsor shows somewhere in the member app, sized by tier --
      none are ever hidden behind a "+N more". You can add more than one Title
      sponsor (e.g. co-presenting sponsors); all of them show. Tap a sponsor above to edit its
      details or swap its logo any time.</p>
      <h3 style="font-size:0.95rem; margin:18px 0 8px;">Add a sponsor</h3>
      <form method="POST" action="/admin/sponsors" id="sponsor-form">
        <label>Name</label><input name="name" required>
        <label>Tier</label>
        <select name="tier">${tierOptionsHtml('partner')}</select>
        <label>Tagline (shown when a member taps this sponsor)</label><input name="tagline" placeholder="e.g. Official food court partner">
        <label>Website link (optional)</label><input name="website_url" type="url" placeholder="https://...">
        <label>Contact link (optional -- WhatsApp, phone, or email)</label>
        <input name="contact_url" placeholder="https://wa.me/9198... or mailto:you@brand.com">
        <label>Logo image (optional -- shown instead of initials)</label>
        <input type="file" class="logo-file-input" data-target="sponsor-logo-data-new" accept="image/*">
        <input type="hidden" name="logo_data_uri" id="sponsor-logo-data-new">
        <button type="submit">Add sponsor</button>
      </form>
    </div>
  `, { forceOpen: forceSponsors }));

  sections.push(section('pass-structure', `Event coupon structure &amp; rules ${published ? '<span style="font-size:0.7rem; font-weight:700; background:var(--good); color:#fff; padding:2px 8px; border-radius:20px; vertical-align:middle;">PUBLISHED &amp; LOCKED</span>' : ''}`, `
    <div class="card">
      <p style="margin-top:0;">Every coupon is now <strong>day-specific</strong> -- one coupon per day of
      the event, auto-created from the event's dates below. There's no separate coupon-type form to fill
      in or get inconsistent day to day. (An earlier "combined, valid across every day" option has been
      removed on purpose: a coupon here is single-use the moment it's scanned once, so a combined
      coupon would have incorrectly locked a genuine multi-day holder out after their very first day's
      entry -- day-specific coupons don't have that problem.) Only VIP status (set per-member above) and
      sponsors/lucky-reveal are configured separately.</p>
      <h3 style="font-size:0.95rem; margin:18px 0 8px;">Currently active (${passTypes.length})</h3>
      <table><tr><th>Title</th><th>Category</th><th>Window</th></tr>${passRows}</table>

      <h3 style="font-size:0.95rem; margin:22px 0 8px;">Transfer rule</h3>
      <p style="font-size:0.85rem; opacity:0.8; margin-top:-4px;">How many times can any one coupon be
      re-transferred after its first hand-off? This is one event-wide rule (not decided per coupon type),
      applied to every currently active coupon so it can't quietly drift.</p>
      <form method="POST" action="/admin/transfer-limit">
        <label>Allowed transfers per coupon</label>
        <input name="transfer_limit" type="number" min="0" max="20" value="${event.transfer_limit}" ${published ? 'disabled' : ''} required>
        <button type="submit" ${published ? 'disabled' : ''}>Save transfer rule</button>
      </form>
      ${published ? '<p style="font-size:0.82rem; opacity:0.75;">This is locked because the event is published. Unpublish below to change it.</p>' : ''}

      <h3 style="font-size:0.95rem; margin:22px 0 8px;">Publish this event</h3>
      <p style="font-size:0.85rem; opacity:0.8; margin-top:-4px;">Publishing locks the transfer rule
      above so it can't be casually re-decided once real coupons are out in the world. You can still
      add members, allotters, and sponsors, and run the lucky reveal, while published -- unpublish any
      time to go back to editing the rule.</p>
      <form method="POST" action="${published ? '/admin/unpublish' : '/admin/publish'}">
        <button type="submit">${published ? 'Unpublish (unlock the transfer rule)' : 'Publish event (lock the transfer rule)'}</button>
      </form>
    </div>
  `, {}));

  sections.push(section('scanner-devices', `Gate scanner devices (${scannerDevices.length})`, `
    <div class="card">
      <p style="margin-top:0;">Only a phone/tablet that has opened one of these activation links can
      grant or deny entry at <code>/verify/:token</code> (what a member's QR actually opens) or the
      manual <a href="/staff">/staff</a> fallback -- any other browser is refused. Give each gate/device
      its own link below rather than sharing one; revoking a device stops it working immediately (it
      doesn't un-set a cookie already issued, so if a device is lost/compromised, treat it as revoked
      and keep an eye out, or rotate the app's signing secret for a hard cutover).</p>
      ${scannerDeviceRows ? `<table><tr><th>Device</th><th>Activation link</th><th></th></tr>${scannerDeviceRows}</table>` : '<p style="opacity:0.7; font-size:0.85rem;">No devices authorized yet -- every /verify/ link will be refused until you add one and open it on that device.</p>'}
      <h3 style="font-size:0.95rem; margin:18px 0 8px;">Authorize a new device</h3>
      <form method="POST" action="/admin/scanner-devices">
        <label>Device name (e.g. "Main gate tablet")</label><input name="name" required>
        <button type="submit">Generate activation link</button>
      </form>
      <h3 style="font-size:0.95rem; margin:22px 0 8px;">Emergency override</h3>
      <p style="font-size:0.85rem; opacity:0.8; margin-top:-4px;">If every authorized device is lost,
      dead, or uncharged mid-event, paste the exact code/token from a member's QR or coupon here to grant
      or deny that one entry directly -- bypassing the device check. This form only exists here on
      /admin, so only whoever holds this admin link can use it.</p>
      <form method="POST" action="/admin/emergency-verify" target="_blank">
        <label>Verification token</label>
        <input name="token" placeholder="paste the code from the coupon" required>
        <button type="submit">Check this one entry</button>
      </form>
    </div>
  `, {}));

  sections.push(section('lucky-draw', 'Lucky coupon reveal', luckyDrawEnabled ? `
    <div class="card">
      <p style="margin-top:0;">Only members currently holding <strong>2 or more</strong> complete entry coupons are
      eligible -- this is checked live, so someone who transfers down to just their own single
      coupon loses their Lucky Coupon immediately (it stops showing on their card at all, not just
      "not revealed yet"). VIP status doesn't add to this count on its own.</p>
      <p>Members see this rule text on their "Grand Finale" card before the reveal, so make it
      concrete about when/how it happens.</p>
      <form method="POST" action="/admin/lucky-rule">
        <label>Rule / announcement text (shown to every member)</label>
        <textarea name="rule_note" rows="2">${esc(rule ? rule.rule_note : '')}</textarea>
        <label>Planned reveal time</label>
        <input name="reveal_at" type="datetime-local" value="${rule ? toLocalInput(rule.reveal_at) : ''}">
        <button type="submit">Save rule</button>
      </form>
      <p style="margin-top:16px;">Status: <strong>${rule && rule.triggered ? 'Already revealed' : 'Not yet revealed'}</strong></p>
      <form method="POST" action="/admin/reveal-now">
        <button type="submit" ${rule && rule.triggered ? 'disabled' : ''}>Reveal Lucky Coupons now (for everyone, at once)</button>
      </form>
    </div>
  ` : `
    <div class="card">
      <p style="margin-top:0;">🔕 Lucky Draw is currently <strong>turned off</strong> (<code>LUCKY_DRAW_ENABLED: false</code> in
      <code>lib/event.config.js</code>). It won't show anywhere on members' app screens.
      Members' coupon counts, transfers, etc. all keep working normally regardless.</p>
      <p style="margin-bottom:0;">Flip that setting back to <code>true</code> and restart the server whenever the rules/prizes
      are finalized -- safe to do any time, even with real members already in the system.</p>
    </div>
  `, {}));

  sections.push(section('testing-tools', 'Testing tools', testingBody, {}));

  return pageShell(`Admin -- ${event.name}`, `
    <p style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
      <span>Organiser configuration for this event -- password-protected, only share the login with people who should have full control.</span>
      <form method="POST" action="/admin/logout" style="margin:0; width:auto;">
        <button type="submit" style="width:auto; padding:6px 12px; margin:0; background:transparent; color:var(--ink); border:1px solid var(--line);">Log out</button>
      </form>
    </p>

    ${flashHtml}

    ${sections.join('')}

    <script>
      // Sponsor / allotter logo pickers -- one shared handler (delegated via
      // data-target) instead of one inline script per row.
      document.querySelectorAll('.logo-file-input').forEach(function(input){
        input.addEventListener('change', function(e){
          var file = e.target.files[0];
          if(!file) return;
          if(file.size > 2*1024*1024){ alert('Please pick an image under 2MB.'); e.target.value=''; return; }
          var targetId = input.getAttribute('data-target');
          var reader = new FileReader();
          reader.onload = function(){ document.getElementById(targetId).value = reader.result; };
          reader.readAsDataURL(file);
        });
      });

      // Remember which top-level sections were open/closed, per browser --
      // a data-force-open section always starts open on the load where it's
      // forced (right after an action inside it), regardless of what was
      // remembered, but still saves normally after that.
      document.querySelectorAll('details.admin-section').forEach(function(d){
        var key = 'gatepass_admin_section_' + d.getAttribute('data-key');
        try {
          if(!d.hasAttribute('data-force-open')){
            var saved = localStorage.getItem(key);
            if(saved === '1') d.setAttribute('open','');
            else if(saved === '0') d.removeAttribute('open');
          }
          d.addEventListener('toggle', function(){
            try { localStorage.setItem(key, d.open ? '1' : '0'); } catch(e){}
          });
        } catch(e){}
      });

      // Opt-in 20s auto-refresh, remembered per browser.
      (function(){
        var cb = document.getElementById('auto-refresh-toggle');
        if(!cb) return;
        var key = 'gatepass_admin_autorefresh';
        var on = false;
        try { on = localStorage.getItem(key) === '1'; } catch(e){}
        cb.checked = on;
        if(on){ setTimeout(function(){ location.reload(); }, 20000); }
        cb.addEventListener('change', function(){
          try { localStorage.setItem(key, cb.checked ? '1' : '0'); } catch(e){}
          if(cb.checked){ setTimeout(function(){ location.reload(); }, 20000); }
        });
      })();
    </script>
  `);
}

// Public page opened via a link an existing member shares (from their
// transfer sheet) instead of typing the receiver's number themselves.
// Deliberately plain/server-rendered like staffPage() -- this is a one-off
// form, not part of the main app bundle.
function claimPage(passId) {
  const body = `
    <div id="claim-root" class="card">Loading…</div>
    <script>
      (function(){
        var passId = ${JSON.stringify(passId)};
        var storeKey = 'gatepass_claim_' + passId;
        var root = document.getElementById('claim-root');

        function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }

        function showForm(info){
          root.innerHTML =
            '<p style="margin-top:0;"><strong>' + esc(info.title) + '</strong></p>' +
            '<p>' + esc(info.description || '') + '</p>' +
            '<p>Enter your details to request this coupon. The current owner (or the organiser) has to' +
            ' approve you before anything moves -- then you' + String.fromCharCode(0x2019) + 'll confirm with a WhatsApp code, same as any transfer.</p>' +
            '<label>Your name</label><input id="c-name">' +
            '<label>Your WhatsApp number</label><input id="c-phone" placeholder="+91 9xxxxxxxxx">' +
            '<button id="c-submit">Request this coupon</button>';
          document.getElementById('c-submit').onclick = function(){
            var name = document.getElementById('c-name').value.trim();
            var phone = document.getElementById('c-phone').value.trim();
            if(!name){ alert('Enter your name'); return; }
            if(phone.replace(/\\D/g,'').length < 8){ alert('Enter a valid WhatsApp number'); return; }
            fetch('/api/claim/' + passId + '/request', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ name: name, whatsapp: phone })
            }).then(function(r){ return r.json(); }).then(function(body){
              if(!body.ok){ alert('Could not send request: ' + body.error); return; }
              localStorage.setItem(storeKey, body.requestId);
              showStatus(body.requestId);
            });
          };
        }

        function showStatus(requestId){
          root.innerHTML = '<p>Checking status…</p>';
          fetch('/api/claim-requests/' + requestId).then(function(r){ return r.json(); }).then(function(body){
            if(!body.ok){ root.innerHTML = '<p>Could not find this request.</p>'; return; }
            if(body.status === 'pending'){
              root.innerHTML =
                '<div class="status"><span class="dot" style="background:var(--accent);"></span><span>Waiting for approval</span></div>' +
                '<p>The coupon owner (or the organiser) needs to approve your request first. This page does not auto-refresh -- come back and tap refresh in a bit.</p>' +
                '<button id="c-refresh">Refresh status</button>';
              document.getElementById('c-refresh').onclick = function(){ showStatus(requestId); };
            } else if(body.status === 'rejected'){
              root.innerHTML =
                '<div class="status"><span class="dot bad"></span><span>Request declined</span></div>' +
                '<p>The owner didn' + String.fromCharCode(0x2019) + 't approve this request.</p>';
              localStorage.removeItem(storeKey);
            } else if(body.status === 'approved'){
              root.innerHTML =
                '<div class="status"><span class="dot good"></span><span>Approved!</span></div>' +
                '<p>Enter the code sent to your WhatsApp to finish.</p>' +
                '<label>OTP</label><input id="c-otp" maxlength="6">' +
                '<button id="c-confirm">Confirm</button>' +
                '<p id="c-msg" style="font-size:0.82rem; opacity:0.75;"></p>';
              document.getElementById('c-confirm').onclick = function(){
                fetch('/api/transfer/confirm', {
                  method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({ transferId: body.transferId, otp: document.getElementById('c-otp').value.trim() })
                }).then(function(r){ return r.json(); }).then(function(res){
                  if(!res.ok){ document.getElementById('c-msg').textContent = 'Error: ' + res.error; return; }
                  localStorage.removeItem(storeKey);
                  root.innerHTML = '<div class="status"><span class="dot good"></span><span>You' + String.fromCharCode(0x2019) + 're in!</span></div>' +
                    '<p>This coupon is now yours. Open your member app:</p>' +
                    '<p><a href="/app/' + res.newMemberId + '">/app/' + res.newMemberId + '</a></p>';
                });
              };
            }
          });
        }

        fetch('/api/passes/' + passId + '/claim-info').then(function(r){ return r.json(); }).then(function(info){
          if(!info.ok){ root.innerHTML = '<p>This link is not valid.</p>'; return; }
          var existingRequestId = localStorage.getItem(storeKey);
          if(existingRequestId){ showStatus(existingRequestId); return; }
          if(!info.transferable){
            var msg = {
              first_transfer_only: 'This coupon has already changed hands once. Claim links only work for a coupon' + String.fromCharCode(0x2019) + 's very first transfer -- ask whoever holds it now to send it to you directly instead.',
              transfer_limit_reached: 'This coupon has already used up its allowed number of transfers.',
              not_available: 'This coupon has already been used or transferred, so it can' + String.fromCharCode(0x2019) + 't be claimed.',
            }[info.reason] || 'This coupon isn' + String.fromCharCode(0x2019) + 't available for transfer right now.';
            root.innerHTML = '<p><strong>' + esc(info.title) + '</strong></p><p>' + msg + '</p>';
            return;
          }
          showForm(info);
        });
      })();
    </script>
  `;
  return pageShell('Request a coupon', body);
}

// Public page for the self-service coupon-request flow: someone needing a
// batch of coupons (e.g. a group representative) enters their own name,
// WhatsApp number, how many they need, and the short code of whichever
// authorized approver they were told to use -- instead of that approver
// typing every recipient in one at a time. Nothing is issued until the
// named approver reviews and approves it. Self-contained fetch-based page,
// same pattern as claimPage() above.
function requestPage() {
  const body = `
    <div id="req-root" class="card">
      <p style="margin-top:0;">Need a batch of entry coupons (e.g. for a group)? Enter your own
      details below, plus the short code the organiser's approver gave you -- they'll review it and
      you'll get your coupons on WhatsApp once approved.</p>
      <label>Your name</label><input id="r-name">
      <label>Your WhatsApp number</label><input id="r-phone" placeholder="+91 9xxxxxxxxx">
      <label>How many coupons do you need?</label><input id="r-qty" type="number" min="1" max="500" value="1">
      <label>Approver's code</label><input id="r-code" placeholder="e.g. 23" inputmode="numeric">
      <button id="r-submit">Send request</button>
    </div>
    <script>
      (function(){
        var storeKey = 'gatepass_allotment_request';
        var root = document.getElementById('req-root');

        function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }

        document.getElementById('r-submit').onclick = function(){
          var name = document.getElementById('r-name').value.trim();
          var phone = document.getElementById('r-phone').value.trim();
          var qty = parseInt(document.getElementById('r-qty').value, 10);
          var code = document.getElementById('r-code').value.trim();
          if(!name){ alert('Enter your name'); return; }
          if(phone.replace(/\\D/g,'').length < 8){ alert('Enter a valid WhatsApp number'); return; }
          if(!qty || qty < 1){ alert('Enter how many coupons you need'); return; }
          if(!code){ alert('Enter the approver' + String.fromCharCode(0x2019) + 's code'); return; }
          fetch('/api/allotment-requests', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ name: name, whatsapp: phone, quantity: qty, code: code })
          }).then(function(r){ return r.json(); }).then(function(res){
            if(!res.ok){
              var msg = { invalid_code: 'That approver code wasn' + String.fromCharCode(0x2019) + 't recognized -- double-check it with whoever gave it to you.' }[res.error]
                || ('Could not send request: ' + res.error);
              alert(msg);
              return;
            }
            localStorage.setItem(storeKey, res.requestId);
            showStatus(res.requestId);
          });
        };

        function showStatus(requestId){
          root.innerHTML = '<p>Checking status…</p>';
          fetch('/api/allotment-requests/' + requestId).then(function(r){ return r.json(); }).then(function(body){
            if(!body.ok){ root.innerHTML = '<p>Could not find this request.</p>'; return; }
            if(body.status === 'pending'){
              root.innerHTML =
                '<div class="status"><span class="dot" style="background:var(--accent);"></span><span>Waiting for approval</span></div>' +
                '<p>The approver needs to review your request first. This page does not auto-refresh -- come back and tap refresh in a bit.</p>' +
                '<button id="r-refresh">Refresh status</button>';
              document.getElementById('r-refresh').onclick = function(){ showStatus(requestId); };
            } else if(body.status === 'rejected'){
              // The approver's note is for their own/the organiser's record-keeping
              // only -- it is intentionally never shown here to the requester.
              root.innerHTML =
                '<div class="status"><span class="dot bad"></span><span>Request declined</span></div>' +
                '<p>The approver didn' + String.fromCharCode(0x2019) + 't approve this request. Contact them directly if you' + String.fromCharCode(0x2019) + 'd like to know why.</p>';
              localStorage.removeItem(storeKey);
            } else if(body.status === 'approved'){
              root.innerHTML =
                '<div class="status"><span class="dot good"></span><span>Approved!</span></div>' +
                '<p>Your ' + body.quantity + ' coupon(s) are ready. Open your member app:</p>' +
                '<p><a href="/app/' + body.memberId + '">/app/' + body.memberId + '</a></p>';
              localStorage.removeItem(storeKey);
            }
          });
        }

        var existingRequestId = localStorage.getItem(storeKey);
        if(existingRequestId){ showStatus(existingRequestId); }
      })();
    </script>
  `;
  return pageShell('Request coupons', body);
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The restricted page an organiser-authorized allotter opens (their own
// /allot/:token link) -- deliberately just the "add member + issue passes"
// capability from /admin, nothing else. Revoking their allotter row makes
// this token 404 immediately.
function allotPage({ valid, token, allotter, event, passTypes, addedMembers, pendingCouponRequests, flash }) {
  flash = flash || {};
  if (!valid) {
    return pageShell('Link not valid', `
      <div class="card"><p style="margin:0;">This allotment link isn't valid, or the organiser has
      revoked it. Ask them for a fresh link if you still need to add attendees.</p></div>
    `);
  }

  const categoryDisplay = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3' };
  const dayCategories = (passTypes || []).map((p) => p.category);
  const canPickDay = !!(allotter && allotter.can_single_day);
  const canGrantVip = !!(allotter && allotter.grants_vip);

  function dayCheckboxes(idPrefix) {
    return dayCategories.map((cat) => `<label style="display:flex; align-items:center; gap:8px; font-size:0.86rem; margin:6px 0;">
        <input type="checkbox" name="day_${cat}" id="${idPrefix}_${cat}" checked style="width:auto;"> ${categoryDisplay[cat] || cat} Entry Coupon
      </label>`).join('');
  }
  function dayFieldHtml(idPrefix) {
    return canPickDay
      ? `<label style="margin-top:12px;">Day(s) this covers</label>${dayCheckboxes(idPrefix)}`
      : `<p style="font-size:0.8rem; opacity:0.7; margin:10px 0 0;">You're set up to always issue every currently active day automatically -- no day picker needed here.</p>`;
  }
  const vipFieldHtml = canGrantVip
    ? `<label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
        <input type="checkbox" name="is_vip" style="width:auto;"> Mark as VIP
      </label>`
    : '';

  const memberRows = (addedMembers || [])
    .map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.whatsapp)}</td><td style="text-align:center;">${m.coupon_count != null ? m.coupon_count : '—'}</td><td><a href="/app/${m.id}">/app/${m.id}</a></td></tr>`)
    .join('');

  // ONE shared note field per request -- it's the same note whichever button
  // is pressed, routed via formaction on the button itself, so there's no
  // longer a confusing "which of these two identical-looking fields do I
  // fill in" moment.
  const pendingRequestCards = (pendingCouponRequests || [])
    .map((r) => `<div class="card">
        <p style="margin-top:0;"><strong>${esc(r.requester_name)}</strong> wants <strong>${r.quantity}</strong> coupon(s)</p>
        <p style="font-size:0.85rem; opacity:0.8; margin-top:-8px;">${esc(r.requester_whatsapp)}</p>
        <form>
          <label>Note (optional, kept on record -- not shown to ${esc(r.requester_name)})</label>
          <input type="text" name="note" placeholder="e.g. Confirmed with team lead">
          <div style="display:flex; gap:8px; margin-top:14px;">
            <button type="submit" formmethod="POST" formaction="/allot/${token}/requests/${r.id}/approve" style="margin-top:0;">Approve -- issue ${r.quantity}</button>
            <button type="submit" formmethod="POST" formaction="/allot/${token}/requests/${r.id}/reject" style="margin-top:0; background:transparent; color:var(--bad); border:1px solid var(--bad);">Reject</button>
          </div>
        </form>
      </div>`)
    .join('');

  let flashHtml = '';
  if (flash.added) {
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ Added. Their link: <a href="/app/${flash.added}">/app/${flash.added}</a></p></div>`;
  } else if (flash.existing) {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ That WhatsApp number already has an account -- no new coupons were issued. Their existing link: <a href="/app/${flash.existing}">/app/${flash.existing}</a></p></div>`;
  } else if (flash.bulkCreated != null) {
    const blank = Number(flash.bulkBlank) || 0;
    const duplicate = Number(flash.bulkDuplicate) || 0;
    const limitBlocked = Number(flash.bulkLimitBlocked) || 0;
    let skipNote = '';
    if (blank || duplicate || limitBlocked) {
      const parts = [];
      if (blank) parts.push(`${blank} blank line(s)`);
      if (duplicate) parts.push(`${duplicate} already-added number(s) -- no duplicate coupons issued`);
      if (limitBlocked) parts.push(`${limitBlocked} that would have gone over your allotment limit`);
      skipNote = ` ${parts.join(', ')} skipped.`;
    }
    flashHtml = `<div class="card" style="border-color:var(--good);"><p>✅ ${flash.bulkCreated} added.${skipNote}</p></div>`;
  } else if (flash.error === 'no_days_selected') {
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Nothing was added -- at least one day must stay checked. Try again below.</p></div>`;
  } else if (flash.error === 'limit_exceeded') {
    const remaining = flash.remaining != null ? Number(flash.remaining) : 0;
    flashHtml = `<div class="card" style="border-color:var(--bad);"><p>⚠️ Nothing was added -- you only have ${remaining} coupon(s) left under your allotment limit. Ask the organiser to raise it, or issue a smaller quantity.</p></div>`;
  }

  return pageShell(`Add attendees -- ${event.name}`, `
    <p>You're authorized by the organiser to add attendees for <strong>${esc(event.name)}</strong>.
    This page can only add people, issue coupons, and review coupon requests sent to your code --
    nothing else about the event can be changed from here.</p>

    ${flashHtml}

    ${pendingCouponRequests && pendingCouponRequests.length ? `
    <h2>Coupon requests waiting on you (${pendingCouponRequests.length})</h2>
    ${pendingRequestCards}` : ''}

    <h2>Add one person</h2>
    <div class="card">
      <form method="POST" action="/allot/${token}/members">
        <label>Name</label><input name="name" required>
        <label>WhatsApp number</label><input name="whatsapp" placeholder="+91 9xxxxxxxxx" required>
        <label>Number of coupons</label>
        <input name="quantity" type="number" min="1" max="500" value="1" required>
        ${dayFieldHtml('single')}
        ${vipFieldHtml}
        <button type="submit">Add &amp; issue coupons</button>
      </form>
    </div>

    <h2>Add a batch</h2>
    <div class="card">
      <form method="POST" action="/allot/${token}/members/bulk">
        <label>Paste one "Name,WhatsApp" pair per line</label>
        <textarea name="csv" rows="5" placeholder="Aman Verma,+919800000001&#10;Riya Shah,+919800000002" required></textarea>
        <label>Number of coupons each person gets</label>
        <input name="quantity" type="number" min="1" max="500" value="1" required>
        ${dayFieldHtml('bulk')}
        ${vipFieldHtml}
        <button type="submit">Add all &amp; issue coupons</button>
      </form>
    </div>

    ${memberRows ? `<h2>People you've added</h2><div class="card"><table><tr><th>Name</th><th>WhatsApp</th><th>Coupons</th><th>Link</th></tr>${memberRows}</table></div>` : ''}
  `);
}

module.exports = { pageShell, verifyResultPage, staffPage, adminPage, adminLoginPage, claimPage, allotPage, requestPage };
