const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const config = require('../config');
const logger = require('../services/logger');
const { TooManyRequestsError } = require('../utils/errors');

// Security middleware
const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

// CORS middleware
const corsMiddleware = cors({
  origin: true, // Allow all origins for now
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
  credentials: false,
  maxAge: 86400
});

// Rate limiting middleware
const createRateLimit = (windowMs, max, message, skipSuccessfulRequests = false) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message,
      type: 'rate_limit',
      retryAfter: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (req, res) => {
      logger.logSecurity('rate limit exceeded', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
        method: req.method
      });
      
      res.status(429).json({
        success: false,
        error: message,
        type: 'rate_limit',
        retryAfter: Math.ceil(windowMs / 1000),
        timestamp: new Date().toISOString()
      });
    }
  });
};

// General rate limiting
const generalRateLimit = createRateLimit(
  config.rateLimit.windowMs,
  config.rateLimit.maxRequests,
  'Too many requests. Please try again later.'
);

// Upload specific rate limiting (more restrictive)
const uploadRateLimit = createRateLimit(
  15 * 60 * 1000, // 15 minutes
  20, // 20 uploads per 15 minutes
  'Too many upload requests. Please try again later.'
);

// Chunk upload rate limiting (very restrictive)
const chunkRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  100, // 100 chunks per 5 minutes
  'Too many chunk upload requests. Please try again later.'
);

// API rate limiting (moderate)
const apiRateLimit = createRateLimit(
  15 * 60 * 1000, // 15 minutes
  200, // 200 API calls per 15 minutes
  'Too many API requests. Please try again later.'
);

// IP-based rate limiting
const ipRateLimit = createRateLimit(
  60 * 60 * 1000, // 1 hour
  1000, // 1000 requests per hour per IP
  'Too many requests from this IP. Please try again later.'
);

// Request size limiting
const requestSizeLimit = (req, res, next) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = 10 * 1024 * 1024; // 10MB for JSON requests
  
  if (contentLength > maxSize) {
    logger.logSecurity('request size exceeded', {
      ip: req.ip,
      contentLength,
      maxSize,
      path: req.path
    });
    
    return res.status(413).json({
      success: false,
      error: 'Request size exceeds limit',
      type: 'request_too_large',
      maxSize: `${maxSize / (1024 * 1024)}MB`,
      timestamp: new Date().toISOString()
    });
  }
  
  next();
};

// Request timeout middleware
const requestTimeout = (timeout = 30000) => {
  return (req, res, next) => {
    req.setTimeout(timeout, () => {
      logger.logSecurity('request timeout', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        timeout
      });
      
      if (!res.headersSent) {
        res.status(408).json({
          success: false,
          error: 'Request timeout',
          type: 'timeout',
          timeout: `${timeout}ms`,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    next();
  };
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  next();
};

// IP whitelist middleware (optional)
const ipWhitelist = (allowedIPs = []) => {
  return (req, res, next) => {
    if (allowedIPs.length === 0) {
      return next(); // No whitelist configured
    }
    
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!allowedIPs.includes(clientIP)) {
      logger.logSecurity('IP not whitelisted', {
        ip: clientIP,
        path: req.path,
        method: req.method
      });
      
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        type: 'forbidden',
        timestamp: new Date().toISOString()
      });
    }
    
    next();
  };
};

// User agent validation middleware
const validateUserAgent = (req, res, next) => {
  const userAgent = req.get('User-Agent');
  
  // Block suspicious user agents
  const suspiciousPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /wget/i,
    /curl/i
  ];
  
  if (suspiciousPatterns.some(pattern => pattern.test(userAgent))) {
    logger.logSecurity('suspicious user agent', {
      userAgent,
      ip: req.ip,
      path: req.path
    });
    
    return res.status(403).json({
      success: false,
      error: 'Access denied',
      type: 'forbidden',
      timestamp: new Date().toISOString()
    });
  }
  
  next();
};

// Request logging middleware
const requestLogger = (req, res, next) => {
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
      logger.error('Server Error', logData);
    } else if (res.statusCode >= 400) {
      logger.warn('Client Error', logData);
    } else {
      logger.info('Request', logData);
    }
  });

  next();
};

// Error logging middleware
const errorLogger = (err, req, res, next) => {
  logger.error('Request Error', {
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
  
  next(err);
};

// Compression middleware
const compression = require('compression');

// Trust proxy middleware (for accurate IP addresses)
const trustProxy = (req, res, next) => {
  // Trust first proxy (useful when behind load balancer)
  req.ip = req.ip || req.connection.remoteAddress;
  next();
};

// Health check bypass middleware
const healthCheckBypass = (req, res, next) => {
  if (req.path === '/health' || req.path === '/health/') {
    return next();
  }
  
  // Apply rate limiting to non-health endpoints
  generalRateLimit(req, res, next);
};

// Upload-specific security middleware
const uploadSecurity = (req, res, next) => {
  // Additional security checks for upload endpoints
  const uploadPaths = ['/api/upload/init', '/api/upload/chunk', '/api/upload/complete'];
  
  if (uploadPaths.includes(req.path)) {
    // Check for suspicious patterns in request
    const suspiciousPatterns = [
      /\.\./,  // Path traversal
      /<script/i,  // XSS attempts
      /javascript:/i,  // JavaScript injection
      /data:text\/html/i  // Data URI HTML
    ];
    
    const requestString = JSON.stringify({
      body: req.body,
      query: req.query,
      params: req.params,
      headers: req.headers
    });
    
    if (suspiciousPatterns.some(pattern => pattern.test(requestString))) {
      logger.logSecurity('suspicious upload request', {
        ip: req.ip,
        path: req.path,
        patterns: suspiciousPatterns.filter(p => p.test(requestString))
      });
      
      return res.status(400).json({
        success: false,
        error: 'Suspicious request detected',
        type: 'security_violation',
        timestamp: new Date().toISOString()
      });
    }
  }
  
  next();
};

module.exports = {
  securityMiddleware,
  corsMiddleware,
  generalRateLimit,
  uploadRateLimit,
  chunkRateLimit,
  apiRateLimit,
  ipRateLimit,
  requestSizeLimit,
  requestTimeout,
  securityHeaders,
  ipWhitelist,
  validateUserAgent,
  requestLogger,
  errorLogger,
  compression,
  trustProxy,
  healthCheckBypass,
  uploadSecurity
};
