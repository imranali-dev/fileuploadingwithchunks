const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const { UploadController, FileController, HealthController } = require('../controllers');
const { 
  validateInitUpload,
  validateCompleteUpload,
  validateCancelUpload,
  validateGetUploadStatus,
  validateListFiles,
  validateDeleteFile,
  validateDownloadFile,
  validateChunkHeaders,
  validateFile
} = require('../middleware/validation');
const { 
  uploadRateLimit,
  chunkRateLimit,
  apiRateLimit,
  uploadSecurity
} = require('../middleware/security');

const router = express.Router();

// Multer configuration for chunk uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const fileId = req.headers['x-file-id'];
      
      if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
        return cb(new Error('Invalid file ID'));
      }
      
      const chunkDir = path.join(config.upload.uploadDir, fileId);
      
      try {
        await fs.access(chunkDir);
      } catch {
        await fs.mkdir(chunkDir, { recursive: true });
      }
      
      cb(null, chunkDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    try {
      const chunkIndex = parseInt(req.headers['x-chunk-index']);
      
      if (isNaN(chunkIndex) || chunkIndex < 0) {
        return cb(new Error('Invalid chunk index'));
      }
      
      cb(null, `chunk-${chunkIndex}`);
    } catch (error) {
      cb(error);
    }
  }
});

const fileFilter = (req, file, cb) => {
  try {
    // Add your file type validation here
    const allowedMimes = config.upload.allowedMimeTypes;
    
    if (allowedMimes && !allowedMimes.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed`));
    }
    
    cb(null, true);
  } catch (error) {
    cb(error);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: config.upload.chunkSizeLimit,
    files: 1
  },
  fileFilter
});

// Upload routes
router.post('/upload/init', 
  uploadRateLimit,
  uploadSecurity,
  validateInitUpload,
  UploadController.initializeUpload
);

router.post('/upload/chunk', 
  chunkRateLimit,
  uploadSecurity,
  validateChunkHeaders,
  upload.single('chunk'),
  validateFile,
  UploadController.uploadChunk
);

router.post('/upload/complete', 
  uploadRateLimit,
  uploadSecurity,
  validateCompleteUpload,
  UploadController.completeUpload
);

router.get('/upload/status/:fileId', 
  apiRateLimit,
  validateGetUploadStatus,
  UploadController.getUploadStatus
);

router.post('/upload/cancel', 
  uploadRateLimit,
  uploadSecurity,
  validateCancelUpload,
  UploadController.cancelUpload
);

// File routes
router.get('/files', 
  apiRateLimit,
  validateListFiles,
  FileController.listFiles
);

router.get('/files/stats', 
  apiRateLimit,
  FileController.getFileStats
);

router.delete('/files/:fileId', 
  apiRateLimit,
  validateDeleteFile,
  FileController.deleteFile
);

router.get('/download/:fileId', 
  apiRateLimit,
  validateDownloadFile,
  FileController.downloadFile
);

// Health check routes
router.get('/health', HealthController.healthCheck);
router.get('/health/detailed', HealthController.detailedHealthCheck);

module.exports = router;
