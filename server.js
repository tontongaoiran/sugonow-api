/**
 * SugoNow API — server.js (MEGA)
 */
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const authRoutes      = require('./src/routes/auth');
const bookingRoutes   = require('./src/routes/bookings');
const driverRoutes    = require('./src/routes/drivers');
const adminRoutes     = require('./src/routes/admin');
const adminMegaRoutes = require('./src/routes/adminMega');
const adminBizRoutes  = require('./src/routes/adminBiz');
const storeRoutes     = require('./src/routes/stores');
const priceRoutes     = require('./src/routes/prices');
const placesRoutes    = require('./src/routes/places');
const landmarksRoutes  = require('./src/routes/landmarks');
const merchantRoutes   = require('./src/routes/merchant');
const pushTokenRoutes   = require('./src/routes/pushToken');
const driverReportRoutes = require('./src/routes/driverReports');
const directionsRoutes   = require('./src/routes/directions');
const receiptRoutes      = require('./src/routes/receipts');
const passRoutes         = require('./src/routes/pass');
const catalogRoutes      = require('./src/routes/catalog');
const subRoutes          = require('./src/routes/substitutions');
const growthRoutes       = require('./src/routes/growth');
const driverWalletRoutes = require('./src/routes/driverWallet');
const messageRoutes      = require('./src/routes/messages');
const adminManageRoutes  = require('./src/routes/adminManage');
const { startDispatchLoop } = require('./src/services/dispatchService');

const app  = express();
const PORT = process.env.PORT || 3000;
// Uploads live here. Locally this is the project's ./uploads folder; on Railway
// set UPLOADS_DIR to the persistent volume mount (e.g. /data/uploads) so photos
// and receipts survive redeploys.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*' }));
app.use('/api/v1/auth/send-otp', rateLimit({ windowMs: 60000, max: 5 }));
app.use('/api/v1', rateLimit({ windowMs: 15*60*1000, max: 2000 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Web Admin Panel (desktop, opens in Chrome) ──────────────────────────────
// Open  http://localhost:3000/admin  (or your hosted URL + /admin).
// Same-origin as the API, so it calls /api/v1/admin/* with no CORS issues.
// We relax the Content-Security-Policy for THIS PAGE ONLY (the admin dashboard
// uses inline scripts); the strict global helmet CSP still protects the API and
// all other routes.
app.get('/admin', (req, res) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "script-src-attr 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "img-src 'self' data:;");
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/bookings', bookingRoutes);
app.use('/api/v1/drivers',  driverRoutes);
app.use('/api/v1/admin',    adminRoutes);
app.use('/api/v1/admin',    adminMegaRoutes);
app.use('/api/v1/admin',    adminBizRoutes);
app.use('/api/v1/stores',   storeRoutes);
app.use('/api/v1/prices',   priceRoutes);
app.use('/api/v1/places',   placesRoutes);
app.use('/api/v1/landmarks', landmarksRoutes);
app.use('/api/v1/merchant',  merchantRoutes);
app.use('/api/v1/push-token',    pushTokenRoutes);
app.use('/api/v1/driver-reports', driverReportRoutes);
app.use('/api/v1/directions',     directionsRoutes);
app.use('/api/v1/receipts',       receiptRoutes);
app.use('/api/v1/pass',           passRoutes);
app.use('/api/v1/catalog',        catalogRoutes);
app.use('/api/v1/substitutions',  subRoutes);
app.use('/api/v1/growth',         growthRoutes);
app.use('/api/v1/driver-wallet',  driverWalletRoutes);
app.use('/api/v1/messages',       messageRoutes);
app.use('/api/v1/admin-manage',   adminManageRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok', app: 'SugoNow API MEGA',
  test_mode: process.env.TEST_MODE === 'true',
  places_configured: !!process.env.GOOGLE_MAPS_API_KEY,
  time: new Date().toISOString(),
}));

app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.path} not found.` }));
app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err.message);
  res.status(500).json({ success: false, message: err.message });
});

app.listen(PORT, () => {
  console.log('\n🛺  SugoNow API MEGA running on port ' + PORT);
  console.log(process.env.TEST_MODE === 'true' ? '⚠️   TEST MODE — OTP 123456' : '✅  Production');
  console.log(process.env.GOOGLE_MAPS_API_KEY ? '🗺   Places + Directions API ✓' : '⚠️   No Google key');
  startDispatchLoop(); // 30s driver rotation
  console.log('');
});

module.exports = app;
