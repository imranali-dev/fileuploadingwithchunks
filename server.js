const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFSBucket } = require('mongodb');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const stream = require('stream');
const util = require('util');
const pipeline = util.promisify(stream.pipeline);

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;
const CHUNK_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB
const TOTAL_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5GB
const FILE_EXPIRY_HOURS = 24;
app.set('trust proxy', 1);

// Logger utility
const logger = {
  info: (msg, meta = {}) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, meta),
  error: (msg, error = {}) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, error),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, meta),
  debug: (msg, meta = {}) => process.env.NODE_ENV === 'development' && console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, meta)
};

// Initialize upload directory with error handling
const initializeUploadDirectory = async () => {
  try {
    await fs.access(UPLOAD_DIR);
    logger.info('Upload directory exists');
  } catch (error) {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      logger.info('Upload directory created', { path: UPLOAD_DIR });
    } catch (mkdirError) {
      logger.error('Failed to create upload directory', mkdirError);
      throw new Error('Cannot initialize upload directory');
    }
  }
};

// Middleware with error handling
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      throw new Error('Invalid JSON payload');
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
});

// Enhanced CORS configuration
app.use((req, res, next) => {
  try {
    res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-chunk-index, x-total-chunks, x-file-id, x-file-name, x-file-size');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  } catch (error) {
    logger.error('CORS middleware error', error);
    next(error);
  }
});

// Rate limiting map (in production, use Redis)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100;

const rateLimit = (req, res, next) => {
  try {
    const identifier = req.ip || 'unknown';
    const now = Date.now();
    const userRequests = rateLimitMap.get(identifier) || [];
    
    // Clean old requests
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(RATE_LIMIT_WINDOW / 1000)
      });
    }
    
    recentRequests.push(now);
    rateLimitMap.set(identifier, recentRequests);
    next();
  } catch (error) {
    logger.error('Rate limit middleware error', error);
    next(); // Don't block on rate limit errors
  }
};

// MongoDB Connection with enhanced retry logic and error handling
const connectDB = async (retries = MAX_RETRIES) => {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Imranali-filesuploader:IR5Kgy5TPgqgE8E4@cluster0.qvhypnz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        minPoolSize: 2,
        retryWrites: true,
        retryReads: true,
        connectTimeoutMS: 10000
      });
      
      logger.info('✅ MongoDB connected successfully', { 
        uri: MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'),
        attempt 
      });
      
      // Set up connection event handlers
      mongoose.connection.on('error', (err) => {
        logger.error('MongoDB connection error', err);
      });
      
      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected. Attempting to reconnect...');
      });
      
      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected successfully');
      });
      
      return;
    } catch (err) {
      logger.error(`MongoDB connection attempt ${attempt}/${retries} failed`, {
        message: err.message,
        code: err.code
      });
      
      if (attempt === retries) {
        throw new Error(`Failed to connect to MongoDB after ${retries} attempts: ${err.message}`);
      }
      
      const delay = RETRY_DELAY * attempt; // Exponential backoff
      logger.info(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Enhanced File Upload Schema with validation
const fileUploadSchema = new mongoose.Schema({
  fileId: { 
    type: String, 
    required: [true, 'File ID is required'],
    unique: true,
    validate: {
      validator: (v) => /^[a-f0-9]{32}$/.test(v),
      message: 'Invalid file ID format'
    }
  },
  originalName: { 
    type: String, 
    required: [true, 'Original filename is required'],
    maxlength: [255, 'Filename too long']
  },
  mimeType: { 
    type: String, 
    required: true,
    default: 'application/octet-stream'
  },
  size: { 
    type: Number, 
    required: true,
    min: [0, 'File size cannot be negative'],
    max: [TOTAL_SIZE_LIMIT, 'File size exceeds maximum limit']
  },
  uploadedChunks: { 
    type: Number, 
    default: 0,
    min: 0
  },
  totalChunks: { 
    type: Number, 
    required: true,
    min: [1, 'Total chunks must be at least 1']
  },
  status: { 
    type: String, 
    enum: {
      values: ['pending', 'uploading', 'completed', 'failed', 'processing', 'cancelled'],
      message: 'Invalid status value'
    },
    default: 'pending'
  },
  gridFsId: { type: mongoose.Schema.Types.ObjectId },
  uploadedBy: { type: String, default: 'anonymous' },
  expiresAt: { 
    type: Date,
    default: () => new Date(Date.now() + FILE_EXPIRY_HOURS * 60 * 60 * 1000)
  },
  metadata: { type: Object, default: {} },
  errorMessage: { type: String },
  retryCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Create indexes separately to avoid duplication
fileUploadSchema.index({ fileId: 1 });
fileUploadSchema.index({ status: 1 });
fileUploadSchema.index({ createdAt: -1 });
fileUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Pre-save hook
fileUploadSchema.pre('save', function(next) {
  try {
    this.updatedAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

const FileUpload = mongoose.model('FileUpload', fileUploadSchema);

// Enhanced async handler with timeout
const asyncHandler = (fn, timeout = 30000) => (req, res, next) => {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timeout')), timeout);
  });

  Promise.race([
    Promise.resolve(fn(req, res, next)),
    timeoutPromise
  ]).catch(next);
};

// Multer configuration with enhanced error handling
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const fileId = req.headers['x-file-id'];
      
      if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
        return cb(new Error('Invalid file ID'));
      }
      
      const chunkDir = path.join(UPLOAD_DIR, fileId);
      
      try {
        await fs.access(chunkDir);
      } catch {
        await fs.mkdir(chunkDir, { recursive: true });
      }
      
      cb(null, chunkDir);
    } catch (error) {
      logger.error('Multer destination error', error);
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
      logger.error('Multer filename error', error);
      cb(error);
    }
  }
});

const fileFilter = (req, file, cb) => {
  try {
    // Add your file type validation here
    const allowedMimes = process.env.ALLOWED_MIME_TYPES 
      ? process.env.ALLOWED_MIME_TYPES.split(',') 
      : null;
    
    if (allowedMimes && !allowedMimes.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed`));
    }
    
    cb(null, true);
  } catch (error) {
    logger.error('File filter error', error);
    cb(error);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: CHUNK_SIZE_LIMIT,
    files: 1
  },
  fileFilter
});

// Input validation helper
const validateInput = (data, rules) => {
  const errors = [];
  
  for (const [field, rule] of Object.entries(rules)) {
    const value = data[field];
    
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} is required`);
      continue;
    }
    
    if (value !== undefined && value !== null) {
      if (rule.type && typeof value !== rule.type) {
        errors.push(`${field} must be of type ${rule.type}`);
      }
      
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${field} must be at least ${rule.min}`);
      }
      
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${field} must not exceed ${rule.max}`);
      }
      
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push(`${field} format is invalid`);
      }
    }
  }
  
  return errors;
};

// Initialize upload session with validation
app.post('/api/upload/init', rateLimit, asyncHandler(async (req, res) => {
  try {
    const { fileName, fileSize, mimeType, totalChunks } = req.body;

    // Validate input
    const validationErrors = validateInput(req.body, {
      fileName: { required: true, type: 'string' },
      fileSize: { required: true, type: 'number', min: 1, max: TOTAL_SIZE_LIMIT },
      totalChunks: { required: true, type: 'number', min: 1 }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Validation failed',
        details: validationErrors
      });
    }

    // Sanitize filename
    const sanitizedFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    
    if (sanitizedFileName.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid filename' 
      });
    }

    const fileId = crypto.randomBytes(16).toString('hex');
    
    const fileUpload = new FileUpload({
      fileId,
      originalName: sanitizedFileName,
      mimeType: mimeType || 'application/octet-stream',
      size: fileSize,
      totalChunks,
      status: 'pending',
      uploadedBy: req.ip || 'unknown'
    });

    await fileUpload.save();

    logger.info('Upload session initialized', { fileId, fileName: sanitizedFileName });

    res.status(201).json({
      success: true,
      data: {
        fileId,
        message: 'Upload session initialized successfully',
        expiresAt: fileUpload.expiresAt
      }
    });
  } catch (error) {
    logger.error('Error initializing upload', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: Object.values(error.errors).map(e => e.message)
      });
    }
    
    throw error;
  }
}));

// Upload chunk with enhanced validation
app.post('/api/upload/chunk', rateLimit, upload.single('chunk'), asyncHandler(async (req, res) => {
  try {
    const fileId = req.headers['x-file-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);

    // Validate headers
    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid chunk index' 
      });
    }

    if (isNaN(totalChunks) || totalChunks < 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid total chunks' 
      });
    }

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No chunk data received' 
      });
    }

    const fileUpload = await FileUpload.findOne({ fileId });

    if (!fileUpload) {
      // Cleanup uploaded chunk
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        logger.error('Error deleting orphaned chunk', unlinkError);
      }
      
      return res.status(404).json({ 
        success: false, 
        error: 'Upload session not found' 
      });
    }

    if (fileUpload.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Upload already completed' 
      });
    }

    if (fileUpload.status === 'cancelled') {
      return res.status(400).json({ 
        success: false, 
        error: 'Upload has been cancelled' 
      });
    }

    if (chunkIndex >= totalChunks) {
      return res.status(400).json({ 
        success: false, 
        error: 'Chunk index exceeds total chunks' 
      });
    }

    // Update with concurrency protection
    const updated = await FileUpload.findOneAndUpdate(
      { 
        fileId,
        uploadedChunks: { $lte: chunkIndex }
      },
      {
        $set: {
          uploadedChunks: chunkIndex + 1,
          status: 'uploading',
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      logger.warn('Chunk already uploaded', { fileId, chunkIndex });
    }

    const currentUpload = updated || fileUpload;

    res.json({
      success: true,
      data: {
        chunkIndex,
        uploadedChunks: currentUpload.uploadedChunks,
        totalChunks: currentUpload.totalChunks,
        progress: ((currentUpload.uploadedChunks / currentUpload.totalChunks) * 100).toFixed(2)
      }
    });

    logger.debug('Chunk uploaded', { fileId, chunkIndex, uploadedChunks: currentUpload.uploadedChunks });
  } catch (error) {
    logger.error('Error uploading chunk', error);
    throw error;
  }
}));

// Complete upload with verification
app.post('/api/upload/complete', rateLimit, asyncHandler(async (req, res) => {
  try {
    const { fileId } = req.body;

    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const fileUpload = await FileUpload.findOne({ fileId });

    if (!fileUpload) {
      return res.status(404).json({ 
        success: false, 
        error: 'Upload session not found' 
      });
    }

    if (fileUpload.status === 'completed') {
      return res.json({
        success: true,
        data: {
          fileId,
          message: 'File already processed',
          status: 'completed'
        }
      });
    }

    if (fileUpload.uploadedChunks !== fileUpload.totalChunks) {
      return res.status(400).json({ 
        success: false, 
        error: `Incomplete upload: ${fileUpload.uploadedChunks}/${fileUpload.totalChunks} chunks received` 
      });
    }

    // Verify all chunks exist
    const chunkDir = path.join(UPLOAD_DIR, fileId);
    try {
      for (let i = 0; i < fileUpload.totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk-${i}`);
        await fs.access(chunkPath);
      }
    } catch (error) {
      logger.error('Missing chunks detected', { fileId, error });
      return res.status(400).json({
        success: false,
        error: 'Some chunks are missing. Please re-upload.'
      });
    }

    fileUpload.status = 'processing';
    await fileUpload.save();

    // Merge chunks in background with error handling
    setImmediate(() => {
      mergeChunks(fileId).catch(async (err) => {
        logger.error(`Error merging chunks for ${fileId}`, err);
        try {
          await FileUpload.findOneAndUpdate(
            { fileId },
            { 
              status: 'failed',
              errorMessage: err.message,
              $inc: { retryCount: 1 }
            }
          );
        } catch (updateError) {
          logger.error('Error updating failed status', updateError);
        }
      });
    });

    res.json({
      success: true,
      data: {
        fileId,
        message: 'Upload completed, processing file...',
        status: 'processing'
      }
    });

    logger.info('Upload marked for processing', { fileId });
  } catch (error) {
    logger.error('Error completing upload', error);
    throw error;
  }
}));

// Enhanced merge chunks with error recovery
async function mergeChunks(fileId) {
  let uploadStream = null;
  
  try {
    const fileUpload = await FileUpload.findOne({ fileId });
    
    if (!fileUpload) {
      throw new Error('File upload record not found');
    }

    if (fileUpload.status === 'completed') {
      logger.info('File already merged', { fileId });
      return;
    }

    const chunkDir = path.join(UPLOAD_DIR, fileId);
    
    // Verify directory exists
    try {
      await fs.access(chunkDir);
    } catch (error) {
      throw new Error(`Chunk directory not found: ${chunkDir}`);
    }

    const bucket = new GridFSBucket(mongoose.connection.db, { 
      bucketName: 'uploads',
      chunkSizeBytes: 261120 // 255KB chunks
    });

    uploadStream = bucket.openUploadStream(fileUpload.originalName, {
      metadata: {
        fileId,
        originalName: fileUpload.originalName,
        mimeType: fileUpload.mimeType,
        uploadDate: new Date(),
        uploadedBy: fileUpload.uploadedBy
      }
    });

    let totalBytesWritten = 0;

    for (let i = 0; i < fileUpload.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk-${i}`);
      
      try {
        const stats = await fs.stat(chunkPath);
        const readStream = fsSync.createReadStream(chunkPath);
        
        await new Promise((resolve, reject) => {
          readStream.on('data', (chunk) => {
            if (!uploadStream.write(chunk)) {
              readStream.pause();
              uploadStream.once('drain', () => readStream.resume());
            }
          });
          
          readStream.on('end', resolve);
          readStream.on('error', reject);
        });
        
        totalBytesWritten += stats.size;
        
        logger.debug(`Merged chunk ${i + 1}/${fileUpload.totalChunks}`, { fileId });
      } catch (error) {
        throw new Error(`Failed to read chunk ${i}: ${error.message}`);
      }
    }

    uploadStream.end();

    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
    });

    // Verify file size
    if (Math.abs(totalBytesWritten - fileUpload.size) > 1024) { // Allow 1KB tolerance
      logger.warn('File size mismatch', { 
        expected: fileUpload.size, 
        actual: totalBytesWritten,
        fileId 
      });
    }

    fileUpload.gridFsId = uploadStream.id;
    fileUpload.status = 'completed';
    fileUpload.updatedAt = new Date();
    await fileUpload.save();

    // Cleanup chunks
    try {
      await fs.rm(chunkDir, { recursive: true, force: true });
      logger.debug('Chunks cleaned up', { fileId });
    } catch (cleanupError) {
      logger.error('Error cleaning up chunks', cleanupError);
      // Don't fail the merge if cleanup fails
    }

    logger.info(`✅ File merged successfully`, { fileId, size: totalBytesWritten });
  } catch (err) {
    logger.error('Merge chunks error', { fileId, error: err.message });
    
    if (uploadStream) {
      try {
        await uploadStream.abort();
      } catch (abortError) {
        logger.error('Error aborting upload stream', abortError);
      }
    }
    
    try {
      await FileUpload.findOneAndUpdate(
        { fileId },
        { 
          status: 'failed',
          errorMessage: err.message
        }
      );
    } catch (updateError) {
      logger.error('Error updating failure status', updateError);
    }
    
    throw err;
  }
}

// Get upload status
app.get('/api/upload/status/:fileId', asyncHandler(async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const fileUpload = await FileUpload.findOne({ fileId }).select('-__v').lean();

    if (!fileUpload) {
      return res.status(404).json({ 
        success: false, 
        error: 'Upload session not found' 
      });
    }

    res.json({
      success: true,
      data: {
        fileId: fileUpload.fileId,
        originalName: fileUpload.originalName,
        size: fileUpload.size,
        status: fileUpload.status,
        uploadedChunks: fileUpload.uploadedChunks,
        totalChunks: fileUpload.totalChunks,
        progress: ((fileUpload.uploadedChunks / fileUpload.totalChunks) * 100).toFixed(2),
        createdAt: fileUpload.createdAt,
        updatedAt: fileUpload.updatedAt,
        expiresAt: fileUpload.expiresAt,
        errorMessage: fileUpload.errorMessage
      }
    });
  } catch (error) {
    logger.error('Error getting upload status', error);
    throw error;
  }
}));

// Download file with range support
app.get('/api/download/:fileId', asyncHandler(async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const fileUpload = await FileUpload.findOne({ 
      fileId, 
      status: 'completed' 
    }).lean();

    if (!fileUpload || !fileUpload.gridFsId) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found or not ready for download' 
      });
    }

    const bucket = new GridFSBucket(mongoose.connection.db, { 
      bucketName: 'uploads' 
    });

    // Support range requests
    const range = req.headers.range;
    let downloadStream;
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileUpload.size - 1;
      const chunksize = (end - start) + 1;

      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileUpload.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': fileUpload.mimeType,
      });

      downloadStream = bucket.openDownloadStream(fileUpload.gridFsId, {
        start,
        end: end + 1
      });
    } else {
      res.set({
        'Content-Type': fileUpload.mimeType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileUpload.originalName)}"`,
        'Content-Length': fileUpload.size,
        'Cache-Control': 'public, max-age=3600'
      });

      downloadStream = bucket.openDownloadStream(fileUpload.gridFsId);
    }

    downloadStream.on('error', (err) => {
      logger.error('Download stream error', { fileId, error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false, 
          error: 'Error downloading file' 
        });
      }
    });

    downloadStream.pipe(res);

    logger.info('File download started', { fileId });
  } catch (error) {
    logger.error('Error initiating download', error);
    throw error;
  }
}));

// List files with enhanced filtering
app.get('/api/files', asyncHandler(async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const query = {};
    if (status && ['pending', 'uploading', 'completed', 'failed', 'processing', 'cancelled'].includes(status)) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [files, total] = await Promise.all([
      FileUpload.find(query)
        .select('-__v -metadata')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      FileUpload.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        files,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Error listing files', error);
    throw error;
  }
}));

// Delete file with cleanup
app.delete('/api/files/:fileId', asyncHandler(async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const fileUpload = await FileUpload.findOne({ fileId });

    if (!fileUpload) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found' 
      });
    }

    // Delete from GridFS if exists
    if (fileUpload.gridFsId) {
      try {
        const bucket = new GridFSBucket(mongoose.connection.db, { 
          bucketName: 'uploads' 
        });
        await bucket.delete(fileUpload.gridFsId);
        logger.debug('Deleted from GridFS', { fileId });
      } catch (gridFsError) {
        logger.error('Error deleting from GridFS', gridFsError);
        // Continue with cleanup even if GridFS delete fails
      }
    }

    // Delete chunk directory if exists
    const chunkDir = path.join(UPLOAD_DIR, fileId);
    try {
      await fs.access(chunkDir);
      await fs.rm(chunkDir, { recursive: true, force: true });
      logger.debug('Deleted chunk directory', { fileId });
    } catch (cleanupError) {
      logger.warn('Chunk directory not found or already deleted', { fileId });
    }

    await FileUpload.deleteOne({ fileId });

    res.json({
      success: true,
      message: 'File deleted successfully'
    });

    logger.info('File deleted', { fileId });
  } catch (error) {
    logger.error('Error deleting file', error);
    throw error;
  }
}));

// Cancel upload
app.post('/api/upload/cancel', asyncHandler(async (req, res) => {
  try {
    const { fileId } = req.body;

    if (!fileId || !/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const fileUpload = await FileUpload.findOne({ fileId });

    if (!fileUpload) {
      return res.status(404).json({ 
        success: false, 
        error: 'Upload session not found' 
      });
    }

    if (fileUpload.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot cancel completed upload' 
      });
    }

    fileUpload.status = 'cancelled';
    fileUpload.updatedAt = new Date();
    await fileUpload.save();

    // Cleanup chunks in background
    const chunkDir = path.join(UPLOAD_DIR, fileId);
    setImmediate(async () => {
      try {
        await fs.rm(chunkDir, { recursive: true, force: true });
        logger.debug('Cancelled upload chunks cleaned up', { fileId });
      } catch (error) {
        logger.error('Error cleaning up cancelled upload', error);
      }
    });

    res.json({
      success: true,
      message: 'Upload cancelled successfully'
    });

    logger.info('Upload cancelled', { fileId });
  } catch (error) {
    logger.error('Error cancelling upload', error);
    throw error;
  }
}));

// Health check routes are handled by app.js - removed duplicate

// Cleanup stale uploads (run periodically)
const cleanupStaleUploads = async () => {
  try {
    const cutoffTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours
    
    const staleUploads = await FileUpload.find({
      status: { $in: ['pending', 'uploading'] },
      updatedAt: { $lt: cutoffTime }
    });

    for (const upload of staleUploads) {
      try {
        const chunkDir = path.join(UPLOAD_DIR, upload.fileId);
        
        try {
          await fs.rm(chunkDir, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn('Error cleaning stale chunks', { fileId: upload.fileId });
        }

        await FileUpload.deleteOne({ fileId: upload.fileId });
        logger.info('Cleaned up stale upload', { fileId: upload.fileId });
      } catch (error) {
        logger.error('Error cleaning individual stale upload', error);
      }
    }

    if (staleUploads.length > 0) {
      logger.info(`Cleaned up ${staleUploads.length} stale uploads`);
    }
  } catch (error) {
    logger.error('Error in cleanup task', error);
  }
};

// Run cleanup every hour
setInterval(cleanupStaleUploads, 60 * 60 * 1000);

// Cleanup orphaned chunks on startup
const cleanupOrphanedChunks = async () => {
  try {
    const uploadDirs = await fs.readdir(UPLOAD_DIR);
    const validFileIds = new Set(
      (await FileUpload.find({}).select('fileId').lean()).map(f => f.fileId)
    );

    for (const dir of uploadDirs) {
      if (!validFileIds.has(dir)) {
        const dirPath = path.join(UPLOAD_DIR, dir);
        try {
          const stats = await fs.stat(dirPath);
          if (stats.isDirectory()) {
            await fs.rm(dirPath, { recursive: true, force: true });
            logger.info('Removed orphaned chunk directory', { dir });
          }
        } catch (error) {
          logger.error('Error removing orphaned directory', { dir, error });
        }
      }
    }
  } catch (error) {
    logger.error('Error cleaning orphaned chunks', error);
  }
};

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Handle specific error types
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        error: `Chunk size exceeds limit of ${CHUNK_SIZE_LIMIT / (1024 * 1024)}MB` 
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ 
        success: false, 
        error: 'Unexpected file field' 
      });
    }
    return res.status(400).json({ 
      success: false, 
      error: `Upload error: ${err.message}` 
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      details: Object.values(err.errors).map(e => e.message)
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid data format'
    });
  }

  if (err.message === 'Request timeout') {
    return res.status(408).json({
      success: false,
      error: 'Request timeout'
    });
  }

  // Don't expose internal errors in production
  const errorMessage = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;

  res.status(err.status || 500).json({
    success: false,
    error: errorMessage,
    ...(process.env.NODE_ENV === 'development' && { 
      stack: err.stack,
      details: err 
    })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path
  });
});

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  try {
    // Stop accepting new connections
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      logger.info('HTTP server closed');
    }

    // Close MongoDB connection
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  
  // Give time to log before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason,
    promise
  });
  
  // In production, you might want to exit
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
});

let server;

// Start server with error handling
const startServer = async () => {
  try {
    // Initialize upload directory
    await initializeUploadDirectory();
    
    // Connect to database
    await connectDB();
    
    // Cleanup orphaned chunks
    await cleanupOrphanedChunks();
    
    // Start listening
    server = app.listen(PORT, () => {
      logger.info('🚀 Server started successfully', {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        uploadDir: UPLOAD_DIR,
        nodeVersion: process.version
      });
    });

    // Handle server errors
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`);
      } else {
        logger.error('Server error', error);
      }
      process.exit(1);
    });

  } catch (err) {
    logger.error('Failed to start server', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  }
};

// Start the application
startServer();