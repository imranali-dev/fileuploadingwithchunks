const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('../config');

class Logger {
  constructor() {
    this.logger = this.createLogger();
    this.setupUncaughtExceptionHandlers();
  }

  createLogger() {
    const transports = [];

    // Console transport for development
    if (config.logging.enableConsole) {
      transports.push(new winston.transports.Console({
        level: config.logging.level,
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let log = `${timestamp} [${level}]: ${message}`;
            if (Object.keys(meta).length > 0) {
              log += ` ${JSON.stringify(meta, null, 2)}`;
            }
            return log;
          })
        )
      }));
    }

    // File transports for production
    if (config.logging.enableFile) {
      // Ensure log directory exists
      if (!fs.existsSync(config.logging.directory)) {
        fs.mkdirSync(config.logging.directory, { recursive: true });
      }

      // Combined log file
      transports.push(new DailyRotateFile({
        filename: path.join(config.logging.directory, 'combined-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: config.logging.fileMaxSize,
        maxFiles: config.logging.fileMaxFiles,
        level: config.logging.level,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        )
      }));

      // Error log file
      transports.push(new DailyRotateFile({
        filename: path.join(config.logging.directory, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: config.logging.fileMaxSize,
        maxFiles: config.logging.fileMaxFiles,
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        )
      }));

      // Access log file
      transports.push(new DailyRotateFile({
        filename: path.join(config.logging.directory, 'access-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: config.logging.fileMaxSize,
        maxFiles: config.logging.fileMaxFiles,
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      }));
    }

    return winston.createLogger({
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: {
        service: 'large-file-upload',
        version: process.env.npm_package_version || '1.0.0',
        environment: config.server.nodeEnv,
        pid: process.pid,
        hostname: require('os').hostname()
      },
      transports,
      exitOnError: false
    });
  }

  setupUncaughtExceptionHandlers() {
    // Handle uncaught exceptions
    this.logger.exceptions.handle(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      })
    );

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Rejection', {
        reason: reason?.message || reason,
        stack: reason?.stack,
        promise: promise.toString()
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      try {
        this.logger.error('Uncaught Exception', {
          error: error.message,
          stack: error.stack
        });
      } catch (logError) {
        console.error('Logger error:', logError);
        console.error('Original error:', error);
      }
      
      // Give time to log before exiting
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });
  }

  // Logging methods
  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  error(message, error = {}) {
    this.logger.error(message, error);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  // Request logging middleware
  requestLogger() {
    return (req, res, next) => {
      const start = Date.now();
      
      res.on('finish', () => {
        const duration = Date.now() - start;
        const logData = {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${duration}ms`,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          contentLength: res.get('Content-Length'),
          referer: req.get('Referer')
        };

        // Log based on status code
        if (res.statusCode >= 500) {
          this.logger.error('Server Error', logData);
        } else if (res.statusCode >= 400) {
          this.logger.warn('Client Error', logData);
        } else {
          this.logger.info('Request', logData);
        }
      });

      next();
    };
  }

  // Upload specific logging
  logUpload(fileId, action, meta = {}) {
    this.logger.info(`Upload ${action}`, {
      fileId,
      action,
      ...meta
    });
  }

  logUploadError(fileId, error, meta = {}) {
    this.logger.error(`Upload Error`, {
      fileId,
      error: error.message,
      stack: error.stack,
      ...meta
    });
  }

  // Database specific logging
  logDatabase(operation, meta = {}) {
    this.logger.info(`Database ${operation}`, meta);
  }

  logDatabaseError(operation, error, meta = {}) {
    this.logger.error(`Database Error`, {
      operation,
      error: error.message,
      stack: error.stack,
      ...meta
    });
  }

  // Security specific logging
  logSecurity(event, meta = {}) {
    this.logger.warn(`Security Event`, {
      event,
      ...meta
    });
  }

  // Performance logging
  logPerformance(operation, duration, meta = {}) {
    this.logger.info(`Performance`, {
      operation,
      duration: `${duration}ms`,
      ...meta
    });
  }

  // Health check logging
  logHealth(status, meta = {}) {
    this.logger.info(`Health Check`, {
      status,
      ...meta
    });
  }

  // Cleanup logging
  logCleanup(action, count, meta = {}) {
    this.logger.info(`Cleanup ${action}`, {
      action,
      count,
      ...meta
    });
  }

  // Get logger instance for external use
  getLogger() {
    return this.logger;
  }

  // Close logger (for graceful shutdown)
  close() {
    return new Promise((resolve) => {
      this.logger.end(() => {
        resolve();
      });
    });
  }
}

module.exports = new Logger();
