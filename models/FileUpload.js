const mongoose = require('mongoose');
const config = require('../config');

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
    maxlength: [255, 'Filename too long'],
    trim: true
  },
  mimeType: { 
    type: String, 
    required: true,
    default: 'application/octet-stream',
    validate: {
      validator: function(v) {
        // Allow all mime types if no restriction is set
        if (!config.upload.allowedMimeTypes) return true;
        return config.upload.allowedMimeTypes.includes(v);
      },
      message: 'File type not allowed'
    }
  },
  size: { 
    type: Number, 
    required: true,
    min: [0, 'File size cannot be negative'],
    max: [config.upload.totalSizeLimit, 'File size exceeds maximum limit']
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
  gridFsId: { 
    type: mongoose.Schema.Types.ObjectId
  },
  uploadedBy: { 
    type: String, 
    default: 'anonymous',
    maxlength: [100, 'Uploader name too long']
  },
  uploadedFrom: {
    ip: { type: String },
    userAgent: { type: String },
    referer: { type: String }
  },
  expiresAt: { 
    type: Date,
    default: () => new Date(Date.now() + config.upload.fileExpiryHours * 60 * 60 * 1000)
  },
  metadata: { 
    type: Object, 
    default: {},
    validate: {
      validator: function(v) {
        // Limit metadata size
        return JSON.stringify(v).length <= 10000;
      },
      message: 'Metadata too large'
    }
  },
  errorMessage: { 
    type: String,
    maxlength: [1000, 'Error message too long']
  },
  retryCount: { 
    type: Number, 
    default: 0,
    max: [config.upload.maxRetries, 'Retry count exceeds maximum']
  },
  checksum: {
    type: String,
    validate: {
      validator: (v) => !v || /^[a-f0-9]{32}$/.test(v),
      message: 'Invalid checksum format'
    }
  },
  processingStartedAt: { type: Date },
  processingCompletedAt: { type: Date },
  downloadCount: { 
    type: Number, 
    default: 0,
    min: 0
  },
  lastDownloadedAt: { type: Date }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Virtual fields
fileUploadSchema.virtual('progress').get(function() {
  if (this.totalChunks === 0) return 0;
  return Math.round((this.uploadedChunks / this.totalChunks) * 100);
});

fileUploadSchema.virtual('isExpired').get(function() {
  return this.expiresAt && this.expiresAt < new Date();
});

fileUploadSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

fileUploadSchema.virtual('isFailed').get(function() {
  return this.status === 'failed';
});

fileUploadSchema.virtual('isProcessing').get(function() {
  return this.status === 'processing';
});

fileUploadSchema.virtual('isUploading').get(function() {
  return this.status === 'uploading';
});

fileUploadSchema.virtual('isPending').get(function() {
  return this.status === 'pending';
});

fileUploadSchema.virtual('isCancelled').get(function() {
  return this.status === 'cancelled';
});

fileUploadSchema.virtual('processingDuration').get(function() {
  if (!this.processingStartedAt || !this.processingCompletedAt) return null;
  return this.processingCompletedAt - this.processingStartedAt;
});

fileUploadSchema.virtual('uploadDuration').get(function() {
  if (!this.createdAt || !this.updatedAt) return null;
  return this.updatedAt - this.createdAt;
});

// Indexes
fileUploadSchema.index({ fileId: 1 }, { unique: true });
fileUploadSchema.index({ status: 1 });
fileUploadSchema.index({ createdAt: -1 });
fileUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
fileUploadSchema.index({ uploadedBy: 1 });
fileUploadSchema.index({ mimeType: 1 });
fileUploadSchema.index({ size: 1 });
fileUploadSchema.index({ gridFsId: 1 });
fileUploadSchema.index({ 'uploadedFrom.ip': 1 });
fileUploadSchema.index({ lastDownloadedAt: -1 });

// Compound indexes
fileUploadSchema.index({ status: 1, createdAt: -1 });
fileUploadSchema.index({ uploadedBy: 1, status: 1 });
fileUploadSchema.index({ mimeType: 1, status: 1 });
fileUploadSchema.index({ size: 1, status: 1 });

// Pre-save hooks
fileUploadSchema.pre('save', function(next) {
  try {
    // Store original status for validation
    if (this.isModified('status') && !this.isNew) {
      this.$locals.originalStatus = this.$locals.originalStatus || this.status;
    }

    // Update processing timestamps
    if (this.isModified('status')) {
      if (this.status === 'processing' && !this.processingStartedAt) {
        this.processingStartedAt = new Date();
      }
      if (this.status === 'completed' && !this.processingCompletedAt) {
        this.processingCompletedAt = new Date();
      }
    }

    // Update download timestamp
    if (this.isModified('downloadCount') && this.downloadCount > 0) {
      this.lastDownloadedAt = new Date();
    }

    this.updatedAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Pre-validate hooks
fileUploadSchema.pre('validate', function(next) {
  try {
    // Validate chunk consistency
    if (this.uploadedChunks > this.totalChunks) {
      return next(new Error('Uploaded chunks cannot exceed total chunks'));
    }

    // Validate status transitions
    const validTransitions = {
      'pending': ['uploading', 'cancelled'],
      'uploading': ['processing', 'failed', 'cancelled'],
      'processing': ['completed', 'failed'],
      'completed': [],
      'failed': ['uploading'],
      'cancelled': []
    };

    if (this.isModified('status') && this.isNew) {
      // Allow initial status
      next();
    } else if (this.isModified('status')) {
      const currentStatus = this.status;
      // Get the previous status from the document's original state
      const previousStatus = this.$locals.previousStatus || (this.$locals.originalStatus || 'pending');
      
      if (!validTransitions[previousStatus]?.includes(currentStatus)) {
        return next(new Error(`Invalid status transition from ${previousStatus} to ${currentStatus}`));
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

// Instance methods
fileUploadSchema.methods.markAsProcessing = function() {
  return this.constructor.findOneAndUpdate(
    { _id: this._id },
    { 
      status: 'processing',
      processingStartedAt: new Date()
    },
    { new: true }
  );
};

fileUploadSchema.methods.markAsCompleted = function(gridFsId) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id },
    { 
      status: 'completed',
      gridFsId: gridFsId,
      processingCompletedAt: new Date()
    },
    { new: true }
  );
};

fileUploadSchema.methods.markAsFailed = function(errorMessage) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id },
    { 
      status: 'failed',
      errorMessage: errorMessage,
      $inc: { retryCount: 1 }
    },
    { new: true }
  );
};

fileUploadSchema.methods.markAsCancelled = function() {
  return this.constructor.findOneAndUpdate(
    { _id: this._id },
    { status: 'cancelled' },
    { new: true }
  );
};

fileUploadSchema.methods.incrementDownloadCount = function() {
  this.downloadCount += 1;
  this.lastDownloadedAt = new Date();
  return this.save();
};

fileUploadSchema.methods.updateChunkProgress = function(chunkIndex) {
  if (chunkIndex >= this.uploadedChunks) {
    this.uploadedChunks = chunkIndex + 1;
    if (this.status === 'pending') {
      this.status = 'uploading';
    }
  }
  return this.save();
};

fileUploadSchema.methods.isChunkUploaded = function(chunkIndex) {
  return chunkIndex < this.uploadedChunks;
};

fileUploadSchema.methods.getMissingChunks = function() {
  const missing = [];
  for (let i = 0; i < this.totalChunks; i++) {
    if (i >= this.uploadedChunks) {
      missing.push(i);
    }
  }
  return missing;
};

// Static methods
fileUploadSchema.statics.findByFileId = function(fileId) {
  return this.findOne({ fileId });
};

fileUploadSchema.statics.findByStatus = function(status) {
  return this.find({ status });
};

fileUploadSchema.statics.findExpired = function() {
  return this.find({
    expiresAt: { $lt: new Date() }
  });
};

fileUploadSchema.statics.findStale = function(hours = 2) {
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.find({
    status: { $in: ['pending', 'uploading'] },
    updatedAt: { $lt: cutoffTime }
  });
};

fileUploadSchema.statics.findByUploader = function(uploadedBy) {
  return this.find({ uploadedBy });
};

fileUploadSchema.statics.findByMimeType = function(mimeType) {
  return this.find({ mimeType });
};

fileUploadSchema.statics.findBySizeRange = function(minSize, maxSize) {
  return this.find({
    size: { $gte: minSize, $lte: maxSize }
  });
};

fileUploadSchema.statics.getStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalSize: { $sum: '$size' },
        avgSize: { $avg: '$size' }
      }
    }
  ]);

  const totalFiles = await this.countDocuments();
  const totalSize = await this.aggregate([
    { $group: { _id: null, totalSize: { $sum: '$size' } } }
  ]);

  return {
    totalFiles,
    totalSize: totalSize[0]?.totalSize || 0,
    byStatus: stats.reduce((acc, stat) => {
      acc[stat._id] = {
        count: stat.count,
        totalSize: stat.totalSize,
        avgSize: Math.round(stat.avgSize)
      };
      return acc;
    }, {})
  };
};

fileUploadSchema.statics.cleanupExpired = async function() {
  const result = await this.deleteMany({
    expiresAt: { $lt: new Date() }
  });
  return result.deletedCount;
};

fileUploadSchema.statics.cleanupStale = async function(hours = 2) {
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const result = await this.deleteMany({
    status: { $in: ['pending', 'uploading'] },
    updatedAt: { $lt: cutoffTime }
  });
  return result.deletedCount;
};

const FileUpload = mongoose.model('FileUpload', fileUploadSchema);

module.exports = FileUpload;
