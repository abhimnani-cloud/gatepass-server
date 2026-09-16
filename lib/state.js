// Single source of truth for "what state is this pass in right now" --
// used by every route so the API, the admin page and the verify page
// can never disagree with each other.

function computeState(memberPass, passType, now) {
  if (memberPass.status === 'used') return 'used';
  if (memberPass.status === 'transferred') return 'transferred';
  const activatesAt = passType.window_start - passType.activate_lead_minutes * 60000;
  if (now < activatesAt) return 'locked';
  if (now > passType.window_end) return 'expired';
  return 'active';
}

module.exports = { computeState };
