const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

class Config {
  constructor() {
    this.validateRequiredEnvVars();
  }

  // Server Configuration
  get server() {
    return {
      port: parseInt(process.env.PORT) || 3000,
      nodeEnv: process.env.NODE_ENV || 'development',
      isDevelopment: process.env.NODE_ENV === 'development',
      isProduction: process.env.NODE_ENV === 'production',
      isTest: process.env.NODE_ENV === 'test'
    };
  }

  // Database Configuration
  get database() {
    return {
      uri: process.env.MONGO_URI || 'mongodb://localhost:27017/large_file_upload',
      dbName: process.env.MONGO_DB_NAME || 'large_file_upload',
      maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE) || 10,
      minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE) || 2,
      connectTimeout: parseInt(process.env.MONGO_CONNECT_TIMEOUT) || 10000,
      serverSelectionTimeout: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT) || 5000,
      socketTimeout: parseInt(process.env.MONGO_SOCKET_TIMEOUT) || 45000,
      retryWrites: true,
      retryReads: true
    };
  }

  // Upload Configuration
  get upload() {
    return {
      uploadDir: process.env.UPLOAD_DIR || './uploads',
      chunkSizeLimit: parseInt(process.env.CHUNK_SIZE_LIMIT) || 50 * 1024 * 1024, // 50MB
      totalSizeLimit: parseInt(process.env.TOTAL_SIZE_LIMIT) || 5 * 1024 * 1024 * 1024, // 5GB
      fileExpiryHours: parseInt(process.env.FILE_EXPIRY_HOURS) || 24,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
      retryDelay: parseInt(process.env.RETRY_DELAY) || 5000,
      allowedMimeTypes: process.env.ALLOWED_MIME_TYPES 
        ? process.env.ALLOWED_MIME_TYPES.split(',').map(type => type.trim())
        : null
    };
  }

  // Security Configuration
  get security() {
    const origins = process.env.ALLOWED_ORIGINS || '*';
    const corsOrigin = origins === '*' ? true : origins.split(',').map(origin => origin.trim());
    
    return {
      allowedOrigins: origins,
      jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
      sessionSecret: process.env.SESSION_SECRET || 'your-super-secret-session-key-change-this-in-production',
      corsOptions: {
        origin: corsOrigin,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type', 
          'Authorization', 
          'x-chunk-index', 
          'x-total-chunks', 
          'x-file-id', 
          'x-file-name', 
          'x-file-size'
        ],
        maxAge: 86400
      }
    };
  }

  // Rate Limiting Configuration
  get rateLimit() {
    return {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000, // 15 minutes
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
      skipSuccessfulRequests: false,
      skipFailedRequests: false
    };
  }

  // Logging Configuration
  get logging() {
    return {
      level: process.env.LOG_LEVEL || 'info',
      fileMaxSize: process.env.LOG_FILE_MAX_SIZE || '20m',
      fileMaxFiles: process.env.LOG_FILE_MAX_FILES || '14d',
      directory: process.env.LOG_DIRECTORY || './logs',
      enableConsole: this.server.isDevelopment,
      enableFile: this.server.isProduction
    };
  }

  // Redis Configuration (Optional)
  get redis() {
    return {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB) || 0,
      enabled: !!process.env.REDIS_URL
    };
  }

  // AWS S3 Configuration (Optional)
  get aws() {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1',
      s3Bucket: process.env.AWS_S3_BUCKET,
      enabled: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    };
  }

  // Email Configuration (Optional)
  get email() {
    return {
      smtpHost: process.env.SMTP_HOST,
      smtpPort: parseInt(process.env.SMTP_PORT) || 587,
      smtpUser: process.env.SMTP_USER,
      smtpPass: process.env.SMTP_PASS,
      fromEmail: process.env.FROM_EMAIL || 'noreply@example.com',
      enabled: !!(process.env.SMTP_HOST && process.env.SMTP_USER)
    };
  }

  // Monitoring Configuration
  get monitoring() {
    return {
      sentryDsn: process.env.SENTRY_DSN,
      healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000,
      cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 3600000,
      enableSentry: !!process.env.SENTRY_DSN
    };
  }

  // Helper methods
  validateRequiredEnvVars() {
    const requiredVars = ['MONGO_URI'];
    const missing = requiredVars.filter(varName => !process.env[varName]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  // Get all configuration as object
  getAll() {
    return {
      server: this.server,
      database: this.database,
      upload: this.upload,
      security: this.security,
      rateLimit: this.rateLimit,
      logging: this.logging,
      redis: this.redis,
      aws: this.aws,
      email: this.email,
      monitoring: this.monitoring
    };
  }

  // Validate configuration
  validate() {
    const errors = [];

    // Validate upload limits
    if (this.upload.chunkSizeLimit <= 0) {
      errors.push('CHUNK_SIZE_LIMIT must be greater than 0');
    }

    if (this.upload.totalSizeLimit <= 0) {
      errors.push('TOTAL_SIZE_LIMIT must be greater than 0');
    }

    if (this.upload.chunkSizeLimit > this.upload.totalSizeLimit) {
      errors.push('CHUNK_SIZE_LIMIT cannot be greater than TOTAL_SIZE_LIMIT');
    }

    // Validate security
    if (this.server.isProduction && this.security.jwtSecret === 'your-super-secret-jwt-key-change-this-in-production') {
      errors.push('JWT_SECRET must be changed in production');
    }

    if (this.server.isProduction && this.security.sessionSecret === 'your-super-secret-session-key-change-this-in-production') {
      errors.push('SESSION_SECRET must be changed in production');
    }

    // Validate database connection string
    if (!this.database.uri.startsWith('mongodb://') && !this.database.uri.startsWith('mongodb+srv://')) {
      errors.push('MONGO_URI must be a valid MongoDB connection string');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    return true;
  }
}

module.exports = new Config();
