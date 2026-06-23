/**
 * SugoNow — src/routes/auth.js (PATCHED for TEST MODE OTP)
 *
 * Fixes:
 * - TEST_MODE now accepts ANY OTP (since no SMS is actually sent)
 * - Verbose logging shows exactly what's happening
 * - OTP is trimmed of whitespace
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../db/pool');
const { customerUpload, driverUpload,
        handleUploadError, fileUrl } = require('../middleware/upload');
const { sendSms } = require('../services/smsService');
const { normalizePhone } = require('../utils/phone');
const { authenticate } = require('../middleware/auth');

const router    = express.Router();

// Save a base64 profile photo to /uploads/profiles, return its relative URL.
// (Registration uses multer; in-app photo changes send base64, like the other
// screenshot uploads in the app.)
const PROFILE_DIR = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), 'profiles');
function saveProfilePhoto(base64) {
  try {
    if (!base64 || !base64.startsWith('data:image')) return null;
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const m = base64.match(/^data:image\/(\w+);base64,(.+)$/);
    let ext = 'jpg', data = base64;
    if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; data = m[2]; }
    const fname = `profile_${Date.now()}_${Math.round(Math.random()*1e6)}.${ext}`;
    fs.writeFileSync(path.join(PROFILE_DIR, fname), Buffer.from(data, 'base64'));
    return `/uploads/profiles/${fname}`;
  } catch { return null; }
}
const TEST_MODE = process.env.TEST_MODE === 'true';

console.log('🔧 auth.js loaded — TEST_MODE =', TEST_MODE);

const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, mobile: user.mobile },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );

// ─── POST /auth/send-otp ──────────────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    let { mobile, purpose = 'registration' } = req.body;
    console.log(`📲 OTP request — mobile: ${mobile} | TEST_MODE: ${TEST_MODE}`);

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Mobile number required.' });
    }
    mobile = normalizePhone(mobile) || mobile.trim();

    if (TEST_MODE) {
      // Try to insert but don't fail if table issues
      try {
        await query(
          `INSERT INTO otp_codes (mobile, code, purpose, expires_at)
           VALUES ($1, '123456', $2, NOW() + INTERVAL '60 minutes')`,
          [mobile.trim(), purpose]
        );
      } catch (e) {
        console.log('  (OTP insert skipped:', e.message, ')');
      }
      console.log(`  ✅ TEST OTP for ${mobile} = 123456`);
      return res.json({
        success:  true,
        message:  'TEST MODE: Use OTP 123456',
        test_otp: '123456',
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    console.log('  [1] normalized mobile =', mobile, '| about to INSERT otp_codes');
    await query(
      `INSERT INTO otp_codes (mobile, code, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
      [mobile.trim(), code, purpose]
    );
    console.log('  [2] otp_codes INSERT ok | about to call Semaphore. KEY present =', !!process.env.SEMAPHORE_API_KEY, '| SENDER =', process.env.SEMAPHORE_SENDER);
    const smsResult = await sendSms(mobile.trim(),
      `SugoNow OTP: ${code}. Valid for 5 minutes.`
    );
    console.log('  [3] Semaphore raw response =', JSON.stringify(smsResult));
    res.json({ success: true, message: 'OTP sent via SMS.' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Could not send OTP.' });
  }
});

// ─── verifyOtpInternal (PATCHED to accept ANY OTP in test mode) ──────────────
const verifyOtpInternal = async (mobile, otp, purpose) => {
  mobile = normalizePhone(mobile) || (mobile || '').trim();
  const cleanOtp = (otp || '').toString().trim();
  console.log(`  🔑 OTP check — TEST_MODE: ${TEST_MODE} | mobile: ${mobile} | otp: "${cleanOtp}"`);

  // In TEST MODE, accept ANY OTP since no real SMS is sent
  if (TEST_MODE) {
    console.log('  ✅ TEST MODE — accepting any OTP');
    return true;
  }

  // Production mode — strict verification
  const { rows } = await query(
    `SELECT id FROM otp_codes
     WHERE mobile=$1 AND code=$2 AND purpose=$3
       AND is_used=FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [mobile.trim(), cleanOtp, purpose]
  );
  if (rows[0]) {
    await query('UPDATE otp_codes SET is_used=TRUE WHERE id=$1', [rows[0].id]);
    return true;
  }
  return false;
};

router.post('/verify-otp', async (req, res) => {
  try {
    const { otp, purpose = 'registration' } = req.body;
    let { mobile } = req.body;
    mobile = normalizePhone(mobile) || (mobile || '').trim();
    const valid = await verifyOtpInternal(mobile, otp, purpose);
    res.json({ success: valid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /auth/register-customer ─────────────────────────────────────────────
router.post('/register-customer',
  (req, res, next) => {
    customerUpload(req, res, (err) => {
      if (err) return handleUploadError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    try {
      const {
        full_name, email, password,
        otp, barangay, zone = 'flora',
      } = req.body;
      let { mobile } = req.body;

      console.log('📝 Customer signup attempt:', { full_name, mobile, otp });

      if (!full_name || !mobile || !password) {
        return res.status(400).json({
          success: false,
          message: 'Name, mobile, and password are required.',
        });
      }
      const normMobile = normalizePhone(mobile);
      if (!normMobile) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid mobile number (e.g. 9171234567).',
        });
      }
      mobile = normMobile;
      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters.',
        });
      }

      const otpValid = await verifyOtpInternal(mobile, otp, 'registration');
      if (!otpValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired OTP code.',
        });
      }

      const existing = await query(
        'SELECT id FROM users WHERE mobile=$1', [mobile.trim()]
      );
      if (existing.rows[0]) {
        return res.status(409).json({
          success: false,
          message: 'Mobile already registered. Try logging in.',
        });
      }

      const zoneRow      = await query('SELECT id FROM zones WHERE slug=$1', [zone]);
      const zoneId       = zoneRow.rows[0]?.id || null;
      const passwordHash = await bcrypt.hash(password, 12);

      const profilePhoto = req.files?.profile_photo?.[0];
      const profileUrl   = profilePhoto ? fileUrl(profilePhoto.filename) : null;

      const { rows } = await query(
        `INSERT INTO users
           (full_name, email, mobile, password_hash, role,
            zone_id, barangay, profile_photo, mobile_verified, is_active)
         VALUES ($1,$2,$3,$4,'customer',$5,$6,$7,TRUE,TRUE)
         RETURNING id, full_name, mobile, role`,
        [
          full_name.trim(),
          email?.trim().toLowerCase() || null,
          mobile.trim(),
          passwordHash,
          zoneId,
          barangay || null,
          profileUrl,
        ]
      );

      const user  = rows[0];
      const token = signToken(user);

      sendSms(mobile.trim(),
        `Welcome to SugoNow, ${full_name.split(' ')[0]}!`
      ).catch(() => {});

      console.log('✅ Customer registered:', user.full_name);

      res.status(201).json({
        success: true,
        message: 'Account created successfully.',
        token,
        user: {
          id:        user.id,
          full_name: user.full_name,
          mobile:    user.mobile,
          role:      user.role,
        },
      });
    } catch (err) {
      console.error('register-customer error:', err.message);
      res.status(500).json({
        success: false,
        message: 'Registration failed: ' + err.message,
      });
    }
  }
);

// ─── POST /auth/register-driver ───────────────────────────────────────────────
router.post('/register-driver',
  (req, res, next) => {
    driverUpload(req, res, (err) => {
      if (err) return handleUploadError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    try {
      const {
        full_name, password,
        barangay, zone = 'flora',
        id_type, plate_no,
        vehicle_color = null, vehicle_model = null,
        reg_lat = null, reg_lng = null, reg_address = null,
      } = req.body;
      let { mobile, vehicle_type } = req.body;

      // Normalize the vehicle type: trim + lowercase + whitelist. A stray
      // space here once made a driver invisible to dispatch — never again.
      vehicle_type = String(vehicle_type || 'tricycle').trim().toLowerCase();
      if (!['tricycle', 'motorcycle'].includes(vehicle_type)) vehicle_type = 'tricycle';

      console.log('🛺 Driver signup:', { full_name, mobile, plate_no });

      if (!full_name || !mobile || !password || !id_type || !plate_no) {
        return res.status(400).json({
          success: false,
          message: 'All fields required: name, mobile, password, ID type, plate.',
        });
      }
      const normMobile = normalizePhone(mobile);
      if (!normMobile) {
        return res.status(400).json({ success: false, message: 'Please enter a valid mobile number (e.g. 9171234567).' });
      }
      mobile = normMobile;

      const idFront = req.files?.id_front?.[0];
      const idBack  = req.files?.id_back?.[0];
      const selfie  = req.files?.selfie?.[0];
      const photo   = req.files?.profile_photo?.[0];

      if (!idFront || !idBack || !selfie || !photo) {
        return res.status(400).json({
          success: false,
          message: 'Please upload all 4 photos: ID front, back, selfie, profile.',
        });
      }

      const existing = await query(
        'SELECT id FROM users WHERE mobile=$1', [mobile.trim()]
      );
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, message: 'Mobile already registered.' });
      }

      const zoneRow      = await query('SELECT id FROM zones WHERE slug=$1', [zone]);
      const zoneId       = zoneRow.rows[0]?.id || null;
      const passwordHash = await bcrypt.hash(password, 12);

      await withTransaction(async (client) => {
        const { rows: uRows } = await client.query(
          `INSERT INTO users
             (full_name, mobile, password_hash, role, zone_id,
              barangay, profile_photo, mobile_verified, is_active)
           VALUES ($1,$2,$3,'driver',$4,$5,$6,FALSE,TRUE)
           RETURNING id`,
          [
            full_name.trim(), mobile.trim(), passwordHash,
            zoneId, barangay || null, fileUrl(photo.filename),
          ]
        );
        const userId = uRows[0].id;

        await client.query(
          `INSERT INTO driver_profiles
             (user_id, plate_number, id_type,
              id_front_url, id_back_url, selfie_url,
              vehicle_type, vehicle_color, vehicle_model, photo_url, status,
              registered_lat, registered_lng, registered_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13)`,
          [
            userId, plate_no.toUpperCase().trim(), id_type,
            fileUrl(idFront.filename), fileUrl(idBack.filename), fileUrl(selfie.filename),
            vehicle_type, vehicle_color, vehicle_model, fileUrl(photo.filename),
            reg_lat ? parseFloat(reg_lat) : null,
            reg_lng ? parseFloat(reg_lng) : null,
            (reg_address || '').trim().slice(0, 200) || null,
          ]
        );
      });

      console.log('✅ Driver registered:', full_name);

      res.status(201).json({
        success: true,
        message: 'Application submitted! Admin will review within 24-48 hours.',
      });
    } catch (err) {
      console.error('register-driver error:', err.message);
      res.status(500).json({ success: false, message: 'Registration failed: ' + err.message });
    }
  }
);

// ─── POST /auth/register-merchant ─────────────────────────────────────────────
// Mirrors register-driver: creates a 'merchant' user + a 'pending' business,
// then admin approves before the store goes live. Returns no token (must wait
// for approval, same as drivers). Uses customerUpload so an optional store
// photo can be sent as 'profile_photo'.
router.post('/register-merchant',
  (req, res, next) => {
    customerUpload(req, res, (err) => {
      if (err) return handleUploadError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    try {
      const {
        full_name, password,
        business_name, category, barangay,
        zone = 'flora', otp, lat, lng,
      } = req.body;
      let { mobile } = req.body;

      console.log('🏪 Merchant signup:', { full_name, mobile, business_name });

      if (!full_name || !mobile || !password || !business_name) {
        return res.status(400).json({
          success: false,
          message: 'Name, mobile, password, and business name are required.',
        });
      }
      const normMobile = normalizePhone(mobile);
      if (!normMobile) {
        return res.status(400).json({ success: false, message: 'Please enter a valid mobile number (e.g. 9171234567).' });
      }
      mobile = normMobile;
      if (password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      }

      const otpValid = await verifyOtpInternal(mobile, otp, 'registration');
      if (!otpValid) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
      }

      const existing = await query('SELECT id FROM users WHERE mobile=$1', [mobile.trim()]);
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, message: 'Mobile already registered. Try logging in.' });
      }

      const zoneRow = await query('SELECT id FROM zones WHERE slug=$1', [zone]);
      const zoneId  = zoneRow.rows[0]?.id || null;
      const passwordHash = await bcrypt.hash(password, 12);

      const photo = req.files?.profile_photo?.[0];
      const photoUrl = photo ? fileUrl(photo.filename) : null;

      await withTransaction(async (client) => {
        const { rows: uRows } = await client.query(
          `INSERT INTO users
             (full_name, mobile, password_hash, role, zone_id,
              barangay, profile_photo, mobile_verified, is_active)
           VALUES ($1,$2,$3,'merchant',$4,$5,$6,TRUE,TRUE)
           RETURNING id`,
          [full_name.trim(), mobile.trim(), passwordHash, zoneId, barangay || null, photoUrl]
        );
        const userId = uRows[0].id;

        const { rows: bRows } = await client.query(
          `INSERT INTO businesses
             (name, category, owner_id, merchant_status, contact_mobile, zone_id, lat, lng)
           VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)
           RETURNING id`,
          [business_name.trim(), category || 'General', userId, mobile.trim(), zoneId,
           lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null]
        );
        const businessId = bRows[0].id;

        await client.query(
          `INSERT INTO merchant_applications (business_id, owner_id, status)
           VALUES ($1,$2,'pending')`,
          [businessId, userId]
        );
      });

      console.log('✅ Merchant registered (pending):', business_name);

      res.status(201).json({
        success: true,
        message: 'Application submitted! SugoNow will review your store within 24-48 hours. You can log in to check your status.',
      });
    } catch (err) {
      console.error('register-merchant error:', err.message);
      res.status(500).json({ success: false, message: 'Registration failed: ' + err.message });
    }
  }
);

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    console.log('🔐 LOGIN —', mobile);

    if (!mobile || !password) {
      return res.status(400).json({ success: false, message: 'Mobile and password required.' });
    }

    const normMobile = normalizePhone(mobile);
    if (!normMobile) {
      return res.status(400).json({ success: false, message: 'Please enter a valid mobile number.' });
    }

    const { rows } = await query(
      `SELECT id, full_name, mobile, role, profile_photo, is_active, password_hash,
              COALESCE(banned, FALSE) AS banned, ban_reason, deleted_at
       FROM users WHERE mobile=$1 AND is_active=TRUE`,
      [normMobile]
    );

    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'Check your details and try again.' });
    }

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ success: false, message: 'Check your details and try again.' });
    }

    // Moderation gates: removed or banned accounts can't sign in
    if (user.deleted_at) {
      return res.status(403).json({ success: false,
        message: 'This account is no longer active. Please contact the SugoNow office in Flora.' });
    }
    if (user.banned) {
      return res.status(403).json({ success: false,
        message: 'Your account has been suspended for violating the SugoNow terms of use. ' +
                 'If you believe this is a mistake, visit the SugoNow office in Flora.' });
    }

    const token = signToken(user);
    console.log('✅ LOGIN —', user.full_name, '(' + user.role + ')');

    // For drivers, include their approval status so the app can show
    // "pending approval" instead of dropping them into the wallet screen.
    let driver_status = null;
    if (user.role === 'driver') {
      const { rows: dp } = await query(
        `SELECT status FROM driver_profiles WHERE user_id=$1`, [user.id]);
      driver_status = dp[0]?.status || null;
    }

    res.json({
      success: true, token,
      user: {
        id:            user.id,
        full_name:     user.full_name,
        mobile:        user.mobile,
        role:          user.role,
        profile_photo: user.profile_photo,
        driver_status,
      },
    });
  } catch (err) {
    // Full diagnostic logging — show name, message, and stack so the real cause
    // is visible in the server logs (a bare err.message can be empty for some
    // error types, e.g. DB driver errors).
    console.error('LOGIN ERROR name:', err.name);
    console.error('LOGIN ERROR message:', err.message);
    console.error('LOGIN ERROR code:', err.code);
    console.error('LOGIN ERROR stack:', err.stack);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { new_password, otp } = req.body;
    let { mobile } = req.body;
    if (!mobile || !new_password || !otp) {
      return res.status(400).json({ success: false, message: 'Mobile, OTP, and new password are required.' });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    mobile = normalizePhone(mobile) || mobile.trim();

    // SECURITY: require a valid OTP (purpose 'reset') proving the requester
    // controls this phone number, before changing the password.
    const verified = await verifyOtpInternal(mobile, otp, 'reset');
    if (!verified) {
      return res.status(403).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    // Only reset if the account actually exists
    const { rows } = await query('SELECT id FROM users WHERE mobile=$1', [mobile]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'No account found for that number.' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash=$1 WHERE mobile=$2', [hash, mobile]);
    res.json({ success: true, message: 'Password reset. You can now log in.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /auth/driver-status — driver checks own approval status ─────────────
router.get('/driver-status', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT status FROM driver_profiles WHERE user_id=$1`, [decoded.id]);
    res.json({ success: true, status: rows[0]?.status || null });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token.' });
  }
});

router.patch('/fcm-token', async (req, res) => {
  try {
    const { fcm_token } = req.body;
    const token   = req.headers.authorization?.split(' ')[1];
    if (!token || !fcm_token) return res.status(400).json({ success: false });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await query('UPDATE users SET fcm_token=$1 WHERE id=$2', [fcm_token, decoded.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT (settings) — all scoped to the logged-in user
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /auth/me — current profile ─────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.mobile, u.email, u.role, u.created_at,
              COALESCE(u.profile_photo, dp.photo_url) AS profile_photo
       FROM users u
       LEFT JOIN driver_profiles dp ON dp.user_id = u.id
       WHERE u.id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, user: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── PATCH /auth/me — edit name / email (NOT mobile; that needs OTP) ─────────
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { full_name, email, profile_photo_base64 } = req.body;
    const sets = [], vals = [];
    if (full_name != null && full_name.trim()) { vals.push(full_name.trim()); sets.push(`full_name=$${vals.length}`); }
    if (email != null) { vals.push(email.trim() || null); sets.push(`email=$${vals.length}`); }
    let newPhotoUrl = null;
    if (profile_photo_base64) {
      newPhotoUrl = saveProfilePhoto(profile_photo_base64);
      if (!newPhotoUrl) return res.status(400).json({ success: false, message: 'Could not save the photo. Please try another image.' });
      vals.push(newPhotoUrl); sets.push(`profile_photo=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update.' });
    vals.push(req.user.id);
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ success: true, message: 'Profile updated.', profile_photo: newPhotoUrl });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /auth/change-password — verify old, set new ───────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password)
      return res.status(400).json({ success: false, message: 'Enter your current and new password.' });
    if (new_password.length < 6)
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    const { rows } = await query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Account not found.' });
    const ok = await bcrypt.compare(old_password, rows[0].password_hash);
    if (!ok) return res.status(400).json({ success: false, message: 'Your current password is incorrect.' });
    const hash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, req.user.id]);
    res.json({ success: true, message: 'Password changed.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Mobile change with OTP ─────────────────────────────────────────────────
// Step 1: request an OTP to the NEW number.
router.post('/change-mobile/request', authenticate, async (req, res) => {
  try {
    let { new_mobile } = req.body;
    new_mobile = normalizePhone(new_mobile) || (new_mobile || '').trim();
    if (!new_mobile) return res.status(400).json({ success: false, message: 'Enter the new mobile number.' });
    const { rows: exists } = await query(
      `SELECT id FROM users WHERE mobile=$1 AND id<>$2 AND is_active=TRUE`, [new_mobile, req.user.id]);
    if (exists.length) return res.status(400).json({ success: false, message: 'That number is already in use.' });
    const code = process.env.TEST_MODE === 'true' ? '123456'
      : String(Math.floor(100000 + Math.random() * 900000));
    await query(
      `INSERT INTO otp_codes (mobile, code, purpose, expires_at)
       VALUES ($1,$2,'change_mobile', NOW() + INTERVAL '10 minutes')`, [new_mobile, code]);
    // OTP is essential SMS — always sends (not gated by NOTIFICATION_SMS).
    await sendSms(new_mobile, `SugoNow: Your code to change your number is ${code}. Valid 10 minutes.`);
    res.json({ success: true, message: 'We sent a code to the new number.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Step 2: verify the OTP and switch the number.
router.post('/change-mobile/verify', authenticate, async (req, res) => {
  try {
    let { new_mobile, code } = req.body;
    new_mobile = normalizePhone(new_mobile) || (new_mobile || '').trim();
    if (!new_mobile || !code) return res.status(400).json({ success: false, message: 'Enter the number and the code.' });
    const { rows } = await query(
      `SELECT id FROM otp_codes
       WHERE mobile=$1 AND code=$2 AND purpose='change_mobile'
         AND expires_at > NOW() AND is_used=FALSE
       ORDER BY created_at DESC LIMIT 1`, [new_mobile, String(code).trim()]);
    if (!rows.length) return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
    await query(`UPDATE otp_codes SET is_used=TRUE WHERE id=$1`, [rows[0].id]);
    await query(`UPDATE users SET mobile=$1 WHERE id=$2`, [new_mobile, req.user.id]);
    res.json({ success: true, message: 'Mobile number updated.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── DELETE /auth/me — soft-delete + anonymize (REQUIRED by app stores) ──────
router.delete('/me', authenticate, async (req, res) => {
  try {
    // Block if the user has an active booking in progress.
    const { rows: act } = await query(
      `SELECT 1 FROM bookings
       WHERE (customer_id=$1 OR driver_id=$1)
         AND status IN ('pending','accepted','arrived','in_progress','waiting') LIMIT 1`,
      [req.user.id]);
    if (act.length) return res.status(400).json({ success: false,
      message: 'You have an active booking. Please finish or cancel it before deleting your account.' });

    // Soft-delete + scrub personal info. Booking/wallet history rows remain for
    // records but the person can no longer log in and their PII is removed.
    const anonMobile = 'deleted_' + req.user.id.slice(0, 8);
    await query(
      `UPDATE users
       SET is_active=FALSE, deleted_at=NOW(),
           full_name='Deleted user', email=NULL,
           mobile=$2, password_hash='', profile_photo=NULL
       WHERE id=$1`, [req.user.id, anonMobile]);
    // If this user is a merchant, take their store(s) offline too — otherwise the
    // storefront stays visible to customers after the account is gone.
    await query(
      `UPDATE businesses SET is_active=FALSE, hidden=TRUE WHERE owner_id=$1`,
      [req.user.id]).catch(() => {});
    res.json({ success: true, message: 'Your account has been deleted.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
