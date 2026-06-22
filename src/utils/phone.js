/**
 * SugoNow — src/utils/phone.js
 *
 * Normalizes any Philippine mobile number to canonical E.164 form: +639XXXXXXXXX
 * This MUST be used everywhere a number enters the system (register, login, OTP,
 * reset) so the same person always maps to the same stored value — otherwise
 * "0917..." and "+63917..." look like different users and break login + create
 * duplicate accounts.
 *
 * Accepts and converts:
 *   09171234567      -> +639171234567   (local leading 0)
 *   639171234567     -> +639171234567   (country code, no +)
 *   +639171234567    -> +639171234567   (already canonical)
 *   9171234567       -> +639171234567   (bare 10-digit)
 *   spaces / dashes  -> stripped first
 *
 * Returns the normalized string, or null if it doesn't look like a valid PH
 * mobile number (so callers can reject it cleanly).
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits and a leading +
  let s = String(raw).trim().replace(/[^\d+]/g, '');

  // Drop a leading + for analysis, remember nothing else
  if (s.startsWith('+')) s = s.slice(1);

  // Now s is digits only. Map the common PH forms to the 10-digit subscriber
  // number starting with 9 (e.g. 9171234567).
  let subscriber = null;
  if (s.startsWith('63') && s.length === 12) {
    subscriber = s.slice(2);            // 639171234567 -> 9171234567
  } else if (s.startsWith('0') && s.length === 11) {
    subscriber = s.slice(1);            // 09171234567 -> 9171234567
  } else if (s.startsWith('9') && s.length === 10) {
    subscriber = s;                     // 9171234567
  } else {
    return null;                        // not a recognizable PH mobile
  }

  // PH mobile subscriber numbers are 10 digits starting with 9
  if (!/^9\d{9}$/.test(subscriber)) return null;

  return `+63${subscriber}`;
}

// True if the raw input is a valid PH mobile number.
function isValidPhone(raw) {
  return normalizePhone(raw) !== null;
}

module.exports = { normalizePhone, isValidPhone };
