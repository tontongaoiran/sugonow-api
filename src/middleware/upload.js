/**
 * SugoNow — src/middleware/upload.js
 * Multer file upload handling for driver IDs and customer photos
 */
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// Ensure uploads folder exists
// Must match server.js's UPLOADS_DIR exactly, or files get SAVED to one folder
// and SERVED from another (every photo 404s). On Railway, set UPLOADS_DIR to a
// persistent volume mount (e.g. /data/uploads) so uploads survive redeploys.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${unique}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Customer registration: profile photo
const customerUpload = upload.fields([
  { name: 'profile_photo', maxCount: 1 },
]);

// Driver registration: ID front, back, selfie, profile
const driverUpload = upload.fields([
  { name: 'id_front',      maxCount: 1 },
  { name: 'id_back',       maxCount: 1 },
  { name: 'selfie',        maxCount: 1 },
  { name: 'profile_photo', maxCount: 1 },
]);

// Cash completion: payment photo
const cashUpload = upload.single('completion_photo');

const handleUploadError = (err, req, res, next) => {
  if (err) {
    return res.status(400).json({
      success: false,
      message: 'Upload failed: ' + err.message,
    });
  }
  next();
};

// Generate URL for uploaded file
const fileUrl = (filename, isPrivate = false) => {
  if (!filename) return null;
  return `/uploads/${filename}`;
};

module.exports = {
  customerUpload, driverUpload, cashUpload,
  handleUploadError, fileUrl,
};
