const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

// Common validation schemas
const commonSchemas = {
  fileId: Joi.string()
    .pattern(/^[a-f0-9]{32}$/)
    .required()
    .messages({
      'string.pattern.base': 'File ID must be a 32-character hexadecimal string',
      'any.required': 'File ID is required'
    }),

  fileName: Joi.string()
    .min(1)
    .max(255)
    .required()
    .messages({
      'string.min': 'Filename cannot be empty',
      'string.max': 'Filename too long',
      'any.required': 'Filename is required'
    }),

  fileSize: Joi.number()
    .integer()
    .min(1)
    .max(5 * 1024 * 1024 * 1024) // 5GB
    .required()
    .messages({
      'number.base': 'File size must be a number',
      'number.integer': 'File size must be an integer',
      'number.min': 'File size must be greater than 0',
      'number.max': 'File size exceeds maximum limit of 5GB',
      'any.required': 'File size is required'
    }),

  mimeType: Joi.string()
    .max(100)
    .optional()
    .messages({
      'string.max': 'MIME type too long'
    }),

  totalChunks: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .required()
    .messages({
      'number.base': 'Total chunks must be a number',
      'number.integer': 'Total chunks must be an integer',
      'number.min': 'Total chunks must be at least 1',
      'number.max': 'Total chunks exceeds maximum limit',
      'any.required': 'Total chunks is required'
    }),

  chunkIndex: Joi.number()
    .integer()
    .min(0)
    .required()
    .messages({
      'number.base': 'Chunk index must be a number',
      'number.integer': 'Chunk index must be an integer',
      'number.min': 'Chunk index must be non-negative',
      'any.required': 'Chunk index is required'
    }),

  uploadedBy: Joi.string()
    .max(100)
    .optional()
    .messages({
      'string.max': 'Uploader name too long'
    }),

  page: Joi.number()
    .integer()
    .min(1)
    .default(1)
    .messages({
      'number.base': 'Page must be a number',
      'number.integer': 'Page must be an integer',
      'number.min': 'Page must be at least 1'
    }),

  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20)
    .messages({
      'number.base': 'Limit must be a number',
      'number.integer': 'Limit must be an integer',
      'number.min': 'Limit must be at least 1',
      'number.max': 'Limit cannot exceed 100'
    }),

  status: Joi.string()
    .valid('pending', 'uploading', 'completed', 'failed', 'processing', 'cancelled')
    .optional()
    .messages({
      'any.only': 'Invalid status value'
    }),

  sortBy: Joi.string()
    .valid('createdAt', 'updatedAt', 'size', 'originalName', 'status')
    .default('createdAt')
    .messages({
      'any.only': 'Invalid sort field'
    }),

  sortOrder: Joi.string()
    .valid('asc', 'desc')
    .default('desc')
    .messages({
      'any.only': 'Sort order must be asc or desc'
    })
};

// Validation schemas for different endpoints
const validationSchemas = {
  // Initialize upload
  initUpload: Joi.object({
    fileName: commonSchemas.fileName,
    fileSize: commonSchemas.fileSize,
    mimeType: commonSchemas.mimeType,
    totalChunks: commonSchemas.totalChunks
  }),

  // Upload chunk
  uploadChunk: Joi.object({
    // Headers validation will be handled separately
  }),

  // Complete upload
  completeUpload: Joi.object({
    fileId: commonSchemas.fileId
  }),

  // Cancel upload
  cancelUpload: Joi.object({
    fileId: commonSchemas.fileId
  }),

  // Get upload status
  getUploadStatus: Joi.object({
    fileId: commonSchemas.fileId
  }),

  // List files
  listFiles: Joi.object({
    page: commonSchemas.page,
    limit: commonSchemas.limit,
    status: commonSchemas.status,
    sortBy: commonSchemas.sortBy,
    sortOrder: commonSchemas.sortOrder
  }),

  // Delete file
  deleteFile: Joi.object({
    fileId: commonSchemas.fileId
  }),

  // Download file
  downloadFile: Joi.object({
    fileId: commonSchemas.fileId
  })
};

// Validation middleware factory
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const data = source === 'body' ? req.body : 
                   source === 'query' ? req.query : 
                   source === 'params' ? req.params : 
                   source === 'headers' ? req.headers : {};

      const { error, value } = schema.validate(data, {
        abortEarly: false,
        stripUnknown: true,
        convert: true
      });

      if (error) {
        const details = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message,
          value: detail.context?.value
        }));

        throw new ValidationError('Validation failed', details);
      }

      // Replace the original data with validated and sanitized data
      if (source === 'body') req.body = value;
      else if (source === 'query') req.query = value;
      else if (source === 'params') req.params = value;
      else if (source === 'headers') req.headers = { ...req.headers, ...value };

      next();
    } catch (err) {
      next(err);
    }
  };
};

// Specific validation middleware functions
const validateInitUpload = validate(validationSchemas.initUpload, 'body');
const validateCompleteUpload = validate(validationSchemas.completeUpload, 'body');
const validateCancelUpload = validate(validationSchemas.cancelUpload, 'body');
const validateGetUploadStatus = validate(validationSchemas.getUploadStatus, 'params');
const validateListFiles = validate(validationSchemas.listFiles, 'query');
const validateDeleteFile = validate(validationSchemas.deleteFile, 'params');
const validateDownloadFile = validate(validationSchemas.downloadFile, 'params');

// Headers validation for chunk upload
const validateChunkHeaders = (req, res, next) => {
  try {
    const schema = Joi.object({
      'x-file-id': commonSchemas.fileId,
      'x-chunk-index': commonSchemas.chunkIndex,
      'x-total-chunks': commonSchemas.totalChunks
    });

    const { error, value } = schema.validate(req.headers, {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });

    if (error) {
      const details = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      }));

      throw new ValidationError('Invalid headers', details);
    }

    // Validate chunk index against total chunks
    if (value['x-chunk-index'] >= value['x-total-chunks']) {
      throw new ValidationError('Chunk index exceeds total chunks');
    }

    // Add validated headers to request
    req.headers = { ...req.headers, ...value };
    next();
  } catch (err) {
    next(err);
  }
};

// File validation middleware
const validateFile = (req, res, next) => {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Validate file size
    if (req.file.size === 0) {
      throw new ValidationError('Cannot upload empty file');
    }

    // Validate file size against chunk limit
    const maxChunkSize = 50 * 1024 * 1024; // 50MB
    if (req.file.size > maxChunkSize) {
      throw new ValidationError(`Chunk size exceeds limit of ${maxChunkSize / (1024 * 1024)}MB`);
    }

    next();
  } catch (err) {
    next(err);
  }
};

// Sanitization middleware
const sanitizeInput = (req, res, next) => {
  try {
    // Sanitize string inputs
    const sanitizeString = (str) => {
      if (typeof str !== 'string') return str;
      return str.trim().replace(/[<>]/g, '');
    };

    // Sanitize body
    if (req.body) {
      for (const key in req.body) {
        if (typeof req.body[key] === 'string') {
          req.body[key] = sanitizeString(req.body[key]);
        }
      }
    }

    // Sanitize query parameters
    if (req.query) {
      for (const key in req.query) {
        if (typeof req.query[key] === 'string') {
          req.query[key] = sanitizeString(req.query[key]);
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

// Rate limiting validation
const validateRateLimit = (req, res, next) => {
  try {
    // This would typically be handled by express-rate-limit middleware
    // This is just for additional validation if needed
    next();
  } catch (err) {
    next(err);
  }
};

// Custom validation for specific business logic
const validateUploadSession = async (req, res, next) => {
  try {
    const fileId = req.params.fileId || req.body.fileId || req.headers['x-file-id'];
    
    if (!fileId) {
      throw new ValidationError('File ID is required');
    }

    // Additional business logic validation can be added here
    // For example, checking if the upload session exists and is valid
    
    next();
  } catch (err) {
    next(err);
  }
};

// Validation error formatter
const formatValidationError = (error) => {
  if (error.name === 'ValidationError') {
    return {
      success: false,
      error: 'Validation failed',
      type: 'validation',
      details: error.details || [],
      timestamp: new Date().toISOString()
    };
  }
  return error;
};

module.exports = {
  validate,
  validateInitUpload,
  validateCompleteUpload,
  validateCancelUpload,
  validateGetUploadStatus,
  validateListFiles,
  validateDeleteFile,
  validateDownloadFile,
  validateChunkHeaders,
  validateFile,
  sanitizeInput,
  validateRateLimit,
  validateUploadSession,
  formatValidationError,
  validationSchemas,
  commonSchemas
};
