/**
 * SugoNow — src/middleware/upload.js
 * Multer file upload handling for driver IDs and customer photos
 */
const multer = require('multer');
const path   = require('path');

// Memory storage: uploaded files arrive as buffers (file.buffer) and are saved
// into Postgres via utils/media.js, so photos persist across redeploys with no
// disk volume. (Was diskStorage, which lost files on every Railway redeploy.)
const storage = multer.memoryStorage();

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
