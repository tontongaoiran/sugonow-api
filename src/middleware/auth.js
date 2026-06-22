/**
 * SugoNow — src/middleware/auth.js
 * JWT authentication and role-based access control
 */
const jwt        = require('jsonwebtoken');
const { query } = require('../db/pool');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided.' });
    }
    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let rows;
    try {
      ({ rows } = await query(
        `SELECT id, full_name, mobile, role, is_active,
                COALESCE(banned, FALSE) AS banned, ban_reason, ban_message, suspended_until
         FROM users WHERE id=$1 AND is_active=TRUE`,
        [decoded.id]));
    } catch (colErr) {
      // Suspension columns may not exist yet (migration not run). Fall back to
      // the minimal query so authentication — and the wallet — never break.
      ({ rows } = await query(
        `SELECT id, full_name, mobile, role, is_active,
                COALESCE(banned, FALSE) AS banned, ban_reason
         FROM users WHERE id=$1 AND is_active=TRUE`,
        [decoded.id]));
    }
    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });
    }
    const u = rows[0];
    // Timed suspension: auto-lift once it has expired.
    if (u.banned && u.suspended_until && new Date(u.suspended_until) < new Date()) {
      await query(
        `UPDATE users SET banned=FALSE, ban_reason=NULL, ban_message=NULL, suspended_until=NULL WHERE id=$1`,
        [u.id]).catch(() => {});
      u.banned = false;
    }
    // Banned/suspended users are blocked on EVERY request (takes effect live,
    // not just at next login). Admins are never blocked.
    if (u.banned && u.role !== 'admin') {
      const until = u.suspended_until
        ? ` until ${new Date(u.suspended_until).toLocaleDateString()}` : '';
      return res.status(403).json({
        success: false,
        banned: true,
        message: (u.ban_message || u.ban_reason ||
          'Your account has been suspended for violating the SugoNow terms of use.') +
          (until ? ` (Suspended${until}.)` : ''),
      });
    }
    req.user = u;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Required role: ${roles.join(' or ')}.`,
    });
  }
  next();
};

const requireVerifiedDriver = async (req, res, next) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ success: false, message: 'Driver access only.' });
    }
    const { rows } = await query(
      `SELECT status FROM driver_profiles WHERE user_id=$1`,
      [req.user.id]
    );
    if (!rows[0] || rows[0].status !== 'verified') {
      return res.status(403).json({
        success: false,
        message: 'Driver account not yet verified by admin.',
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { authenticate, requireRole, requireVerifiedDriver };
