const fileUploadService = require('../services/fileUpload');
const logger = require('../services/logger');
const { 
  ValidationError, 
  NotFoundError, 
  UploadError,
  asyncHandler 
} = require('../utils/errors');

class UploadController {
  // Initialize upload session
  initializeUpload = asyncHandler(async (req, res) => {
    try {
      const { fileName, fileSize, mimeType, totalChunks } = req.body;
      const uploadedBy = req.body.uploadedBy || 'anonymous';
      const uploadedFrom = {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        referer: req.get('Referer')
      };

      const result = await fileUploadService.initializeUpload(
        { fileName, fileSize, mimeType, totalChunks },
        uploadedBy,
        uploadedFrom
      );

      res.status(201).json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('initialize upload', error, {
        ip: req.ip,
        body: req.body
      });
      throw error;
    }
  });

  // Upload chunk
  uploadChunk = asyncHandler(async (req, res) => {
    try {
      const fileId = req.headers['x-file-id'];
      const chunkIndex = parseInt(req.headers['x-chunk-index']);
      const totalChunks = parseInt(req.headers['x-total-chunks']);

      if (!req.file) {
        throw new ValidationError('No chunk data received');
      }

      // Read the uploaded chunk file
      const fs = require('fs').promises;
      const chunkData = await fs.readFile(req.file.path);

      const result = await fileUploadService.uploadChunk(
        fileId,
        chunkIndex,
        chunkData,
        totalChunks
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('upload chunk', error, {
        fileId: req.headers['x-file-id'],
        chunkIndex: req.headers['x-chunk-index'],
        ip: req.ip
      });
      throw error;
    }
  });

  // Complete upload
  completeUpload = asyncHandler(async (req, res) => {
    try {
      const { fileId } = req.body;

      const result = await fileUploadService.completeUpload(fileId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('complete upload', error, {
        fileId: req.body.fileId,
        ip: req.ip
      });
      throw error;
    }
  });

  // Get upload status
  getUploadStatus = asyncHandler(async (req, res) => {
    try {
      const { fileId } = req.params;

      const result = await fileUploadService.getUploadStatus(fileId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('get upload status', error, {
        fileId: req.params.fileId,
        ip: req.ip
      });
      throw error;
    }
  });

  // Cancel upload
  cancelUpload = asyncHandler(async (req, res) => {
    try {
      const { fileId } = req.body;

      const result = await fileUploadService.cancelUpload(fileId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('cancel upload', error, {
        fileId: req.body.fileId,
        ip: req.ip
      });
      throw error;
    }
  });
}

class FileController {
  // List files
  listFiles = asyncHandler(async (req, res) => {
    try {
      // Set default values for query parameters
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Cap at 100
      const status = req.query.status;
      const sortBy = req.query.sortBy || 'createdAt';
      const sortOrder = req.query.sortOrder || 'desc';
      
      logger.info('List files request', { page, limit, status, sortBy, sortOrder });
      
      // Ensure database connection before querying
      const mongoose = require('mongoose');
      
      // Check database connection
      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        
        // Return empty result instead of error for better UX
        return res.json({
          success: true,
          data: {
            files: [],
            pagination: {
              page,
              limit,
              total: 0,
              pages: 0
            }
          },
          message: 'Database temporarily unavailable - showing empty list'
        });
      }
      
      const FileUpload = require('../models/FileUpload');
      
      const query = {};
      if (status && ['pending', 'uploading', 'processing', 'completed', 'failed', 'cancelled'].includes(status)) {
        query.status = status;
      }

      const skip = Math.max(0, (page - 1) * limit);
      const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

      logger.info('Database query', { query, skip, limit, sort });

      const [files, total] = await Promise.all([
        FileUpload.find(query)
          .select('-__v')
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean()
          .catch(err => {
            logger.error('Error finding files', err);
            throw err;
          }),
        FileUpload.countDocuments(query)
          .catch(err => {
            logger.error('Error counting files', err);
            throw err;
          })
      ]);

      logger.info('Files retrieved', { count: files.length, total });

      res.json({
        success: true,
        data: {
          files: files || [],
          pagination: {
            page,
            limit,
            total: total || 0,
            pages: Math.ceil((total || 0) / limit)
          }
        }
      });

    } catch (error) {
      logger.error('Error listing files', {
        message: error.message,
        stack: error.stack,
        query: req.query
      });
      
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to retrieve files',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Delete file
  deleteFile = asyncHandler(async (req, res) => {
    try {
      const { fileId } = req.params;

      const result = await fileUploadService.deleteFile(fileId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.logUploadError('delete file', error, {
        fileId: req.params.fileId,
        ip: req.ip
      });
      throw error;
    }
  });

  // Download file
  downloadFile = asyncHandler(async (req, res) => {
    try {
      const { fileId } = req.params;

      const FileUpload = require('../models/FileUpload');
      const { GridFSBucket } = require('mongodb');
      const mongoose = require('mongoose');

      const fileUpload = await FileUpload.findOne({ 
        fileId, 
        status: 'completed' 
      }).lean();

      if (!fileUpload || !fileUpload.gridFsId) {
        throw new NotFoundError('File not found or not ready for download');
      }

      const bucket = fileUploadService.getBucket();
      if (!bucket) {
        throw new Error('Database not connected');
      }

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
        logger.logUploadError('download stream error', err, { fileId });
        if (!res.headersSent) {
          res.status(500).json({ 
            success: false, 
            error: 'Error downloading file' 
          });
        }
      });

      downloadStream.pipe(res);

      // Increment download count
      await FileUpload.findOneAndUpdate(
        { fileId },
        { $inc: { downloadCount: 1 } }
      );

      logger.logUpload(fileId, 'download started', {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

    } catch (error) {
      logger.logUploadError('download file', error, {
        fileId: req.params.fileId,
        ip: req.ip
      });
      throw error;
    }
  });

  // Get file stats
  getFileStats = asyncHandler(async (req, res) => {
    try {
      const FileUpload = require('../models/FileUpload');
      
      const stats = await FileUpload.getStats();

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error getting file stats', error);
      throw error;
    }
  });
}

class HealthController {
  // Health check
  healthCheck = asyncHandler(async (req, res) => {
    try {
      const mongoose = require('mongoose');
      
      // Quick database check
      let dbStatus = 'disconnected';
      let dbError = null;
      
      try {
        if (mongoose.connection.readyState === 1) {
          // Try a simple ping
          await mongoose.connection.db.admin().ping();
          dbStatus = 'connected';
        }
      } catch (err) {
        dbError = err.message;
        dbStatus = 'error';
      }
      
      const health = {
        status: dbStatus === 'connected' ? 'OK' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mongodb: {
          status: dbStatus,
          readyState: mongoose.connection.readyState,
          error: dbError
        },
        memory: process.memoryUsage(),
        system: {
          platform: process.platform,
          nodeVersion: process.version,
          arch: process.arch,
          env: process.env.NODE_ENV
        }
      };

      const statusCode = health.status === 'OK' ? 200 : 503;
      res.status(statusCode).json(health);

    } catch (error) {
      logger.error('Health check error', error);
      
      res.status(503).json({
        status: 'UNHEALTHY',
        timestamp: new Date().toISOString(),
        error: error.message,
        mongodb: {
          status: 'error',
          readyState: 0
        }
      });
    }
  });

  // Detailed health check
  detailedHealthCheck = asyncHandler(async (req, res) => {
    try {
      const databaseService = require('../services/database');
      const fileUploadService = require('../services/fileUpload');
      
      const [dbHealth, uploadStats] = await Promise.all([
        databaseService.healthCheck(),
        fileUploadService.getStats ? fileUploadService.getStats() : null
      ]);
      
      const health = {
        status: dbHealth.status === 'healthy' ? 'OK' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mongodb: dbHealth,
        uploads: uploadStats,
        memory: process.memoryUsage(),
        system: {
          platform: process.platform,
          nodeVersion: process.version,
          pid: process.pid,
          hostname: require('os').hostname(),
          loadAverage: require('os').loadavg(),
          freeMemory: require('os').freemem(),
          totalMemory: require('os').totalmem()
        }
      };

      const statusCode = health.status === 'OK' ? 200 : 503;
      res.status(statusCode).json(health);

    } catch (error) {
      logger.error('Detailed health check error', error);
      
      res.status(503).json({
        status: 'UNHEALTHY',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  });
}

module.exports = {
  UploadController: new UploadController(),
  FileController: new FileController(),
  HealthController: new HealthController()
};
