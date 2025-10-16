const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const config = require('./config');
const logger = require('./services/logger');
const databaseService = require('./services/database');
const fileUploadService = require('./services/fileUpload');
const { HealthController } = require('./controllers');
const { 
  errorHandler, 
  notFoundHandler,
  unhandledRejectionHandler,
  uncaughtExceptionHandler
} = require('./utils/errors');
const {
  securityMiddleware,
  corsMiddleware,
  requestLogger,
  errorLogger,
  compression,
  trustProxy,
  securityHeaders
} = require('./middleware/security');

class Application {
  constructor() {
    this.app = express();
    this.server = null;
    this.setupErrorHandlers();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupCleanupTasks();
  }

  setupErrorHandlers() {
    // Handle unhandled promise rejections
    process.on('unhandledRejection', unhandledRejectionHandler);
    
    // Handle uncaught exceptions
    process.on('uncaughtException', uncaughtExceptionHandler);
    
    // Handle shutdown signals
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
  }

  setupMiddleware() {
    // Trust proxy (for accurate IP addresses behind load balancer)
    this.app.use(trustProxy);
    
    // Security middleware
    this.app.use(securityMiddleware);
    this.app.use(securityHeaders);
    
    // CORS middleware
    this.app.use(corsMiddleware);
    
    // Compression middleware
    this.app.use(compression());
    
    // Request logging
    this.app.use(requestLogger);
    
    // Body parsing middleware
    this.app.use(express.json({ 
      limit: '10mb',
      verify: (req, res, buf, encoding) => {
        try {
          JSON.parse(buf);
        } catch (e) {
          throw new Error('Invalid JSON payload');
        }
      }
    }));
    
    this.app.use(express.urlencoded({ 
      extended: true, 
      limit: '10mb' 
    }));
    
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    // Add logger to request object
    this.app.use((req, res, next) => {
      req.logger = logger;
      next();
    });
  }

  setupRoutes() {
    // Health check routes (at root level for compatibility)
    this.app.get('/health', HealthController.healthCheck);
    this.app.get('/health/detailed', HealthController.detailedHealthCheck);
    
    // API routes
    this.app.use('/api', require('./routes/api'));
    
    // Serve the main HTML file
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'index.html'));
    });
    
    // 404 handler
    this.app.use(notFoundHandler);
    
    // Error handler (must be last)
    this.app.use(errorLogger);
    this.app.use(errorHandler);
  }

  setupCleanupTasks() {
    // Cleanup expired uploads every hour
    setInterval(async () => {
      try {
        await fileUploadService.cleanupExpiredUploads();
      } catch (error) {
        logger.error('Error in expired uploads cleanup', error);
      }
    }, config.monitoring.cleanupInterval);

    // Cleanup stale uploads every 2 hours
    setInterval(async () => {
      try {
        await fileUploadService.cleanupStaleUploads(2);
      } catch (error) {
        logger.error('Error in stale uploads cleanup', error);
      }
    }, 2 * 60 * 60 * 1000);

    // Cleanup orphaned chunks every 6 hours
    setInterval(async () => {
      try {
        await fileUploadService.cleanupOrphanedChunks();
      } catch (error) {
        logger.error('Error in orphaned chunks cleanup', error);
      }
    }, 6 * 60 * 60 * 1000);
  }

  async initialize() {
    try {
      // Validate configuration
      config.validate();
      
      // Initialize upload directory
      await this.initializeUploadDirectory();
      
      // Connect to database
      await databaseService.connect();
      
      // Create database indexes
      await databaseService.createIndexes();
      
      // Cleanup orphaned chunks on startup
      await fileUploadService.cleanupOrphanedChunks();
      
      logger.info('Application initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize application', error);
      throw error;
    }
  }

  async initializeUploadDirectory() {
    try {
      await fs.access(config.upload.uploadDir);
      logger.info('Upload directory exists', { path: config.upload.uploadDir });
    } catch (error) {
      try {
        await fs.mkdir(config.upload.uploadDir, { recursive: true });
        logger.info('Upload directory created', { path: config.upload.uploadDir });
      } catch (mkdirError) {
        logger.error('Failed to create upload directory', mkdirError);
        throw new Error('Cannot initialize upload directory');
      }
    }
  }

  async start() {
    try {
      await this.initialize();
      
      // Start server
      this.server = this.app.listen(config.server.port, () => {
        logger.info('🚀 Server started successfully', {
          port: config.server.port,
          environment: config.server.nodeEnv,
          uploadDir: config.upload.uploadDir,
          nodeVersion: process.version,
          pid: process.pid
        });
      });

      // Handle server errors
      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${config.server.port} is already in use`);
        } else {
          logger.error('Server error', error);
        }
        process.exit(1);
      });

    } catch (error) {
      logger.error('Failed to start server', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    }
  }

  async gracefulShutdown(signal) {
    logger.info(`${signal} received, shutting down gracefully...`);
    
    try {
      // Stop accepting new connections
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
        logger.info('HTTP server closed');
      }

      // Close database connection
      await databaseService.gracefulShutdown();

      // Close logger
      await logger.close();

      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', error);
      process.exit(1);
    }
  }

  getApp() {
    return this.app;
  }

  getServer() {
    return this.server;
  }
}

// Create and start the application
// Export Express app for Vercel
const application = new Application();
module.exports = application.getApp();

// Only start the server locally (not on Vercel)
if (process.env.NODE_ENV !== 'production') {
  application.start().catch((error) => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}
