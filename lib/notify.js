// WhatsApp OTP delivery -- pluggable so the mock is a one-function swap.
//
// This sandbox has no outbound network access to any messaging provider,
// so `sendOtp` below just logs the code and returns it in the API response
// (clearly marked "demo mode" -- see routes/transfer.js). Nothing here
// pretends to send a real WhatsApp message.
//
// To go live, replace the body of sendOtp() with one real HTTP call.
// You only need ONE of these, matching whichever WhatsApp Business API
// provider you sign up with:
//
//   --- Meta Cloud API (official, needs a verified WhatsApp Business number) ---
//   await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
//     method: 'POST',
//     headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
//     body: JSON.stringify({
//       messaging_product: 'whatsapp', to: phone,
//       type: 'template',
//       template: { name: 'otp_code', language: { code: 'en' },
//         components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }] }
//     })
//   });
//
//   --- Gupshup / AiSensy / Twilio (aggregators, faster to onboard) ---
//   Same idea: one POST with your API key and the destination number.
//   Check whichever provider's docs for the exact payload shape.
//
// Keep the OTP *generation and verification* (routes/transfer.js) exactly
// as-is either way -- only this file's transport needs to change.

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtp(phone, code) {
  console.log(`[notify:MOCK] Would send WhatsApp OTP ${code} to ${phone}`);
  return { ok: true, mode: 'mock' };
}

// Generic (non-OTP) WhatsApp message -- same mock-transport idea as
// sendOtp() above, used for things like "your coupons are ready" once a
// coupon request is approved. Swap the body the same way you would sendOtp.
async function sendMessage(phone, text) {
  console.log(`[notify:MOCK] Would send WhatsApp message to ${phone}: ${text}`);
  return { ok: true, mode: 'mock' };
}

module.exports = { generateOtp, sendOtp, sendMessage };
