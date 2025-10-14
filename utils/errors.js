// Custom Error Classes
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = []) {
    super(message, 400);
    this.details = details;
    this.type = 'validation';
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
    this.type = 'not_found';
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access') {
    super(message, 401);
    this.type = 'unauthorized';
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden access') {
    super(message, 403);
    this.type = 'forbidden';
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409);
    this.type = 'conflict';
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', retryAfter = null) {
    super(message, 429);
    this.type = 'rate_limit';
    this.retryAfter = retryAfter;
  }
}

class UploadError extends AppError {
  constructor(message, fileId = null, chunkIndex = null) {
    super(message, 400);
    this.type = 'upload';
    this.fileId = fileId;
    this.chunkIndex = chunkIndex;
  }
}

class DatabaseError extends AppError {
  constructor(message, operation = null) {
    super(message, 500);
    this.type = 'database';
    this.operation = operation;
  }
}

class FileSystemError extends AppError {
  constructor(message, path = null, operation = null) {
    super(message, 500);
    this.type = 'filesystem';
    this.path = path;
    this.operation = operation;
  }
}

class NetworkError extends AppError {
  constructor(message, url = null) {
    super(message, 503);
    this.type = 'network';
    this.url = url;
  }
}

class TimeoutError extends AppError {
  constructor(message = 'Request timeout', timeout = null) {
    super(message, 408);
    this.type = 'timeout';
    this.timeout = timeout;
  }
}

// Error handler middleware
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  if (req.logger) {
    req.logger.error('Error occurred', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      body: req.body,
      query: req.query,
      params: req.params
    });
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Invalid ID format';
    error = new ValidationError(message);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists`;
    error = new ConflictError(message);
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const details = err.errors ? Object.values(err.errors).map(e => e.message) : [err.message];
    const message = 'Validation failed';
    error = new ValidationError(message, details);
  }

  // Multer errors
  if (err.name === 'MulterError') {
    let message = 'File upload error';
    let statusCode = 400;

    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File size exceeds limit';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files';
        break;
      case 'LIMIT_FIELD_KEY':
        message = 'Field name too long';
        break;
      case 'LIMIT_FIELD_VALUE':
        message = 'Field value too long';
        break;
      case 'LIMIT_FIELD_COUNT':
        message = 'Too many fields';
        break;
      case 'LIMIT_PART_COUNT':
        message = 'Too many parts';
        break;
      default:
        message = err.message;
    }

    error = new UploadError(message);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = new UnauthorizedError(message);
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = new UnauthorizedError(message);
  }

  // Rate limit errors
  if (err.statusCode === 429) {
    error = new TooManyRequestsError(err.message, err.retryAfter);
  }

  // Network errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    error = new NetworkError('Service unavailable', err.hostname);
  }

  // Timeout errors
  if (err.code === 'ETIMEDOUT') {
    error = new TimeoutError('Request timeout');
  }

  // Default to 500 server error
  if (!error.statusCode) {
    error = new AppError('Internal server error', 500);
  }

  // Prepare error response
  const response = {
    success: false,
    error: error.message,
    type: error.type || 'error',
    timestamp: error.timestamp || new Date().toISOString(),
    path: req.path,
    method: req.method
  };

  // Add additional details in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = error.stack;
    response.details = error.details;
    response.originalError = {
      name: err.name,
      message: err.message,
      code: err.code
    };
  }

  // Add retry information for rate limits
  if (error.retryAfter) {
    response.retryAfter = error.retryAfter;
  }

  res.status(error.statusCode || 500).json(response);
};

// Async error handler wrapper
const asyncHandler = (fn, timeout = 30000) => {
  return (req, res, next) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new TimeoutError('Request timeout', timeout)), timeout);
    });

    Promise.race([
      Promise.resolve(fn(req, res, next)),
      timeoutPromise
    ]).catch(next);
  };
};

// 404 handler
const notFoundHandler = (req, res) => {
  const error = new NotFoundError(`Route ${req.path}`);
  
  res.status(404).json({
    success: false,
    error: error.message,
    type: error.type,
    timestamp: error.timestamp,
    path: req.path,
    method: req.method
  });
};

// Unhandled promise rejection handler
const unhandledRejectionHandler = (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  
  // In production, you might want to exit
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
};

// Uncaught exception handler
const uncaughtExceptionHandler = (error) => {
  console.error('Uncaught Exception:', error);
  
  // Give time to log before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
};

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
  UploadError,
  DatabaseError,
  FileSystemError,
  NetworkError,
  TimeoutError,
  errorHandler,
  asyncHandler,
  notFoundHandler,
  unhandledRejectionHandler,
  uncaughtExceptionHandler
};
