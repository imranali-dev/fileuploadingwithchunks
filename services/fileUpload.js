const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GridFSBucket } = require('mongodb');
const mongoose = require('mongoose');
const config = require('../config');
const logger = require('./logger');
const FileUpload = require('../models/FileUpload');
const { 
  UploadError, 
  FileSystemError, 
  DatabaseError, 
  ValidationError,
  NotFoundError 
} = require('../utils/errors');

class FileUploadService {
  constructor() {
    this.uploadDir = config.upload.uploadDir;
    this.chunkSizeLimit = config.upload.chunkSizeLimit;
    this.totalSizeLimit = config.upload.totalSizeLimit;
    this.maxRetries = config.upload.maxRetries;
    this.retryDelay = config.upload.retryDelay;
    this.fileExpiryHours = config.upload.fileExpiryHours;
    this.bucket = null;
    this.initializeBucket();
  }

  initializeBucket() {
    // GridFS bucket will be initialized when needed
    this.bucket = null;
  }

  getBucket() {
    if (!this.bucket && mongoose.connection.readyState === 1) {
      this.bucket = new GridFSBucket(mongoose.connection.db, {
        bucketName: 'uploads',
        chunkSizeBytes: 261120 // 255KB chunks
      });
    }
    return this.bucket;
  }

  // Initialize upload session
  async initializeUpload(fileData, uploadedBy = 'anonymous', uploadedFrom = {}) {
    try {
      const { fileName, fileSize, mimeType, totalChunks } = fileData;

      // Validate input
      this.validateFileData(fileData);

      // Sanitize filename
      const sanitizedFileName = this.sanitizeFileName(fileName);
      
      // Generate unique file ID
      const fileId = crypto.randomBytes(16).toString('hex');
      
      // Create file upload record
      const fileUpload = new FileUpload({
        fileId,
        originalName: sanitizedFileName,
        mimeType: mimeType || 'application/octet-stream',
        size: fileSize,
        totalChunks,
        status: 'pending',
        uploadedBy,
        uploadedFrom,
        expiresAt: new Date(Date.now() + this.fileExpiryHours * 60 * 60 * 1000)
      });

      await fileUpload.save();

      logger.logUpload(fileId, 'initialized', {
        fileName: sanitizedFileName,
        fileSize,
        totalChunks,
        uploadedBy
      });

      return {
        fileId,
        expiresAt: fileUpload.expiresAt,
        message: 'Upload session initialized successfully'
      };

    } catch (error) {
      logger.logUploadError('initialization', error);
      
      if (error.name === 'ValidationError') {
        throw new ValidationError('Invalid file data', Object.values(error.errors).map(e => e.message));
      }
      
      throw new UploadError(`Failed to initialize upload: ${error.message}`);
    }
  }

  // Upload chunk
  async uploadChunk(fileId, chunkIndex, chunkData, totalChunks) {
    try {
      // Validate inputs
      this.validateFileId(fileId);
      this.validateChunkIndex(chunkIndex, totalChunks);

      // Find file upload record
      const fileUpload = await FileUpload.findByFileId(fileId);
      if (!fileUpload) {
        throw new NotFoundError('Upload session');
      }

      // Check if upload is still active
      if (fileUpload.status === 'completed') {
        throw new UploadError('Upload already completed', fileId, chunkIndex);
      }

      if (fileUpload.status === 'cancelled') {
        throw new UploadError('Upload has been cancelled', fileId, chunkIndex);
      }

      if (chunkIndex >= totalChunks) {
        throw new UploadError('Chunk index exceeds total chunks', fileId, chunkIndex);
      }

      // Check if chunk already uploaded
      if (fileUpload.isChunkUploaded(chunkIndex)) {
        logger.logUpload(fileId, 'chunk already uploaded', { chunkIndex });
        return {
          chunkIndex,
          uploadedChunks: fileUpload.uploadedChunks,
          totalChunks: fileUpload.totalChunks,
          progress: fileUpload.progress
        };
      }

      // Save chunk to disk
      const chunkPath = await this.saveChunk(fileId, chunkIndex, chunkData);

      // Update progress with concurrency protection
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

      const currentUpload = updated || fileUpload;

      logger.logUpload(fileId, 'chunk uploaded', {
        chunkIndex,
        uploadedChunks: currentUpload.uploadedChunks,
        totalChunks: currentUpload.totalChunks
      });

      return {
        chunkIndex,
        uploadedChunks: currentUpload.uploadedChunks,
        totalChunks: currentUpload.totalChunks,
        progress: currentUpload.progress
      };

    } catch (error) {
      logger.logUploadError('chunk upload', error, { fileId, chunkIndex });
      
      // Cleanup chunk if upload failed
      try {
        await this.deleteChunk(fileId, chunkIndex);
      } catch (cleanupError) {
        logger.logUploadError('chunk cleanup', cleanupError, { fileId, chunkIndex });
      }
      
      throw error;
    }
  }

  // Complete upload
  async completeUpload(fileId) {
    try {
      this.validateFileId(fileId);

      const fileUpload = await FileUpload.findByFileId(fileId);
      if (!fileUpload) {
        throw new NotFoundError('Upload session');
      }

      if (fileUpload.status === 'completed') {
        return {
          fileId,
          message: 'File already processed',
          status: 'completed'
        };
      }

      if (fileUpload.uploadedChunks !== fileUpload.totalChunks) {
        throw new UploadError(
          `Incomplete upload: ${fileUpload.uploadedChunks}/${fileUpload.totalChunks} chunks received`,
          fileId
        );
      }

      // Verify all chunks exist
      await this.verifyChunks(fileId, fileUpload.totalChunks);

      // Mark as processing
      await fileUpload.markAsProcessing();

      // Merge chunks in background
      setImmediate(() => {
        this.mergeChunks(fileId).catch(async (err) => {
          logger.logUploadError('merge chunks', err, { fileId });
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
            logger.logUploadError('update failed status', updateError, { fileId });
          }
        });
      });

      logger.logUpload(fileId, 'marked for processing');

      return {
        fileId,
        message: 'Upload completed, processing file...',
        status: 'processing'
      };

    } catch (error) {
      logger.logUploadError('complete upload', error, { fileId });
      throw error;
    }
  }

  // Merge chunks into GridFS
  async mergeChunks(fileId) {
    let uploadStream = null;
    
    try {
      const fileUpload = await FileUpload.findByFileId(fileId);
      
      if (!fileUpload) {
        throw new Error('File upload record not found');
      }

      if (fileUpload.status === 'completed') {
        logger.logUpload(fileId, 'already merged');
        return;
      }

      const chunkDir = path.join(this.uploadDir, fileId);
      
      // Verify directory exists
      try {
        await fs.access(chunkDir);
      } catch (error) {
        throw new FileSystemError(`Chunk directory not found: ${chunkDir}`, chunkDir, 'access');
      }

      // Initialize GridFS upload stream
      const bucket = this.getBucket();
      if (!bucket) {
        throw new Error('Database not connected');
      }
      
      uploadStream = bucket.openUploadStream(fileUpload.originalName, {
        metadata: {
          fileId,
          originalName: fileUpload.originalName,
          mimeType: fileUpload.mimeType,
          uploadDate: new Date(),
          uploadedBy: fileUpload.uploadedBy,
          uploadedFrom: fileUpload.uploadedFrom
        }
      });

      let totalBytesWritten = 0;

      // Merge chunks sequentially
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
          
          logger.logUpload(fileId, 'chunk merged', { 
            chunkIndex: i + 1, 
            totalChunks: fileUpload.totalChunks 
          });
        } catch (error) {
          throw new FileSystemError(`Failed to read chunk ${i}: ${error.message}`, chunkPath, 'read');
        }
      }

      uploadStream.end();

      await new Promise((resolve, reject) => {
        uploadStream.on('finish', resolve);
        uploadStream.on('error', reject);
      });

      // Verify file size
      if (Math.abs(totalBytesWritten - fileUpload.size) > 1024) {
        logger.logUpload(fileId, 'size mismatch', {
          expected: fileUpload.size,
          actual: totalBytesWritten
        });
      }

      // Update file upload record
      await fileUpload.markAsCompleted(uploadStream.id);

      // Cleanup chunks
      await this.cleanupChunks(fileId);

      logger.logUpload(fileId, 'merge completed', {
        size: totalBytesWritten,
        gridFsId: uploadStream.id
      });

    } catch (error) {
      logger.logUploadError('merge chunks', error, { fileId });
      
      if (uploadStream) {
        try {
          await uploadStream.abort();
        } catch (abortError) {
          logger.logUploadError('abort upload stream', abortError, { fileId });
        }
      }
      
      try {
        await FileUpload.findOneAndUpdate(
          { fileId },
          { 
            status: 'failed',
            errorMessage: error.message
          }
        );
      } catch (updateError) {
        logger.logUploadError('update failure status', updateError, { fileId });
      }
      
      throw error;
    }
  }

  // Get upload status
  async getUploadStatus(fileId) {
    try {
      this.validateFileId(fileId);

      const fileUpload = await FileUpload.findByFileId(fileId);
      if (!fileUpload) {
        throw new NotFoundError('Upload session');
      }

      return {
        fileId: fileUpload.fileId,
        originalName: fileUpload.originalName,
        size: fileUpload.size,
        status: fileUpload.status,
        uploadedChunks: fileUpload.uploadedChunks,
        totalChunks: fileUpload.totalChunks,
        progress: fileUpload.progress,
        createdAt: fileUpload.createdAt,
        updatedAt: fileUpload.updatedAt,
        expiresAt: fileUpload.expiresAt,
        errorMessage: fileUpload.errorMessage,
        uploadedBy: fileUpload.uploadedBy,
        mimeType: fileUpload.mimeType
      };

    } catch (error) {
      logger.logUploadError('get status', error, { fileId });
      throw error;
    }
  }

  // Cancel upload
  async cancelUpload(fileId) {
    try {
      this.validateFileId(fileId);

      const fileUpload = await FileUpload.findByFileId(fileId);
      if (!fileUpload) {
        throw new NotFoundError('Upload session');
      }

      if (fileUpload.status === 'completed') {
        throw new UploadError('Cannot cancel completed upload', fileId);
      }

      await fileUpload.markAsCancelled();

      // Cleanup chunks in background
      setImmediate(async () => {
        try {
          await this.cleanupChunks(fileId);
        } catch (error) {
          logger.logUploadError('cleanup cancelled upload', error, { fileId });
        }
      });

      logger.logUpload(fileId, 'cancelled');

      return {
        fileId,
        message: 'Upload cancelled successfully'
      };

    } catch (error) {
      logger.logUploadError('cancel upload', error, { fileId });
      throw error;
    }
  }

  // Delete file
  async deleteFile(fileId) {
    try {
      this.validateFileId(fileId);

      const fileUpload = await FileUpload.findByFileId(fileId);
      if (!fileUpload) {
        throw new NotFoundError('File');
      }

      // Delete from GridFS if exists
      if (fileUpload.gridFsId) {
        try {
          const bucket = this.getBucket();
          if (bucket) {
            await bucket.delete(fileUpload.gridFsId);
            logger.logUpload(fileId, 'deleted from GridFS');
          }
        } catch (gridFsError) {
          logger.logUploadError('delete from GridFS', gridFsError, { fileId });
        }
      }

      // Cleanup chunks
      await this.cleanupChunks(fileId);

      // Delete record
      await FileUpload.deleteOne({ fileId });

      logger.logUpload(fileId, 'deleted');

      return {
        fileId,
        message: 'File deleted successfully'
      };

    } catch (error) {
      logger.logUploadError('delete file', error, { fileId });
      throw error;
    }
  }

  // Helper methods
  async saveChunk(fileId, chunkIndex, chunkData) {
    try {
      const chunkDir = path.join(this.uploadDir, fileId);
      
      // Ensure directory exists
      try {
        await fs.access(chunkDir);
      } catch {
        await fs.mkdir(chunkDir, { recursive: true });
      }
      
      const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);
      await fs.writeFile(chunkPath, chunkData);
      
      return chunkPath;
    } catch (error) {
      const chunkPath = path.join(this.uploadDir, fileId, `chunk-${chunkIndex}`);
      throw new FileSystemError(`Failed to save chunk: ${error.message}`, chunkPath, 'write');
    }
  }

  async deleteChunk(fileId, chunkIndex) {
    try {
      const chunkPath = path.join(this.uploadDir, fileId, `chunk-${chunkIndex}`);
      await fs.unlink(chunkPath);
    } catch (error) {
      // Ignore file not found errors
      if (error.code !== 'ENOENT') {
        throw new FileSystemError(`Failed to delete chunk: ${error.message}`, chunkPath, 'delete');
      }
    }
  }

  async cleanupChunks(fileId) {
    try {
      const chunkDir = path.join(this.uploadDir, fileId);
      await fs.rm(chunkDir, { recursive: true, force: true });
      logger.logUpload(fileId, 'chunks cleaned up');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new FileSystemError(`Failed to cleanup chunks: ${error.message}`, chunkDir, 'cleanup');
      }
    }
  }

  async verifyChunks(fileId, totalChunks) {
    try {
      const chunkDir = path.join(this.uploadDir, fileId);
      
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk-${i}`);
        await fs.access(chunkPath);
      }
    } catch (error) {
      throw new UploadError('Some chunks are missing. Please re-upload.', fileId);
    }
  }

  validateFileData(fileData) {
    const { fileName, fileSize, totalChunks } = fileData;
    
    if (!fileName || typeof fileName !== 'string') {
      throw new ValidationError('Invalid filename');
    }
    
    if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0) {
      throw new ValidationError('Invalid file size');
    }
    
    if (fileSize > this.totalSizeLimit) {
      throw new ValidationError(`File size exceeds maximum limit of ${this.totalSizeLimit}`);
    }
    
    if (!totalChunks || typeof totalChunks !== 'number' || totalChunks <= 0) {
      throw new ValidationError('Invalid total chunks');
    }
  }

  validateFileId(fileId) {
    if (!fileId || typeof fileId !== 'string' || !/^[a-f0-9]{32}$/.test(fileId)) {
      throw new ValidationError('Invalid file ID format');
    }
  }

  validateChunkIndex(chunkIndex, totalChunks) {
    if (typeof chunkIndex !== 'number' || chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new ValidationError('Invalid chunk index');
    }
  }

  sanitizeFileName(fileName) {
    const sanitized = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    
    if (sanitized.length === 0) {
      throw new ValidationError('Invalid filename');
    }
    
    return sanitized;
  }

  // Cleanup methods
  async cleanupExpiredUploads() {
    try {
      const expiredUploads = await FileUpload.findExpired();
      let cleanedCount = 0;

      for (const upload of expiredUploads) {
        try {
          await this.cleanupChunks(upload.fileId);
          await FileUpload.deleteOne({ fileId: upload.fileId });
          cleanedCount++;
        } catch (error) {
          logger.logUploadError('cleanup expired upload', error, { fileId: upload.fileId });
        }
      }

      logger.logCleanup('expired uploads', cleanedCount);
      return cleanedCount;
    } catch (error) {
      logger.logUploadError('cleanup expired uploads', error);
      throw error;
    }
  }

  async cleanupStaleUploads(hours = 2) {
    try {
      const staleUploads = await FileUpload.findStale(hours);
      let cleanedCount = 0;

      for (const upload of staleUploads) {
        try {
          await this.cleanupChunks(upload.fileId);
          await FileUpload.deleteOne({ fileId: upload.fileId });
          cleanedCount++;
        } catch (error) {
          logger.logUploadError('cleanup stale upload', error, { fileId: upload.fileId });
        }
      }

      logger.logCleanup('stale uploads', cleanedCount);
      return cleanedCount;
    } catch (error) {
      logger.logUploadError('cleanup stale uploads', error);
      throw error;
    }
  }

  async cleanupOrphanedChunks() {
    try {
      const uploadDirs = await fs.readdir(this.uploadDir);
      const validFileIds = new Set(
        (await FileUpload.find({}).select('fileId').lean()).map(f => f.fileId)
      );

      let cleanedCount = 0;

      for (const dir of uploadDirs) {
        if (!validFileIds.has(dir)) {
          const dirPath = path.join(this.uploadDir, dir);
          try {
            const stats = await fs.stat(dirPath);
            if (stats.isDirectory()) {
              await fs.rm(dirPath, { recursive: true, force: true });
              cleanedCount++;
            }
          } catch (error) {
            logger.logUploadError('cleanup orphaned directory', error, { dir });
          }
        }
      }

      logger.logCleanup('orphaned chunks', cleanedCount);
      return cleanedCount;
    } catch (error) {
      logger.logUploadError('cleanup orphaned chunks', error);
      throw error;
    }
  }
}

module.exports = new FileUploadService();
