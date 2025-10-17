// vercel-app.js - Wrapper for Vercel deployment
// This wraps your existing app.js to work with Vercel's serverless architecture

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

// Import your existing modules
const config = require('./config');
const apiRoutes = require('./routes/api');
const { errorHandler } = require('./utils/errors');
const logger = require('./services/logger');

const app = express();

// Trust proxy for Vercel
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
// Vercel serverless functions have a 4.5MB request limit
const bodyLimit = process.env.VERCEL ? '4mb' : '10mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'x-chunk-index', 
    'x-total-chunks', 
    'x-file-id', 
    'x-file-name', 
    'x-file-size'
  ]
}));

// Cache MongoDB connection for Vercel
let cachedDb = null;

async function connectToDatabase() {
  // If already connected, return immediately
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }

  try {
    const mongoUri = process.env.MONGO_URI || config.database.uri;
    
    if (!mongoUri) {
      throw new Error('MONGO_URI environment variable is not set');
    }

    const options = {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 2,
      bufferCommands: true,
      retryWrites: true,
      retryReads: true
    };

    // Close existing connection if it's in a bad state
    if (mongoose.connection.readyState === 2 || mongoose.connection.readyState === 3) {
      await mongoose.connection.close();
    }

    // Connect if not already connected
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(mongoUri, options);
    }
    
    cachedDb = mongoose.connection;
    logger.info('MongoDB connected successfully');
    return cachedDb;
    
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    cachedDb = null;
    throw error;
  }
}

// Health check endpoints
app.get('/health', async (req, res) => {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    res.status(dbConnected ? 200 : 503).json({
      status: dbConnected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      database: dbConnected ? 'connected' : 'disconnected',
      platform: 'vercel',
      warning: 'Chunked uploads may not work properly on Vercel serverless'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/health/detailed', async (req, res) => {
  try {
    await connectToDatabase();
    
    const dbStatus = mongoose.connection.readyState;
    const statusMap = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      platform: 'vercel-serverless',
      database: {
        status: statusMap[dbStatus],
        name: mongoose.connection.name || 'unknown'
      },
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
      },
      uptime: process.uptime() + ' seconds',
      warnings: [
        'Vercel serverless functions are stateless',
        'Chunked uploads require persistent state',
        'File uploads may fail for large files',
        'Consider using Railway, Render, or traditional hosting'
      ]
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Serve static files
app.use(express.static('./', {
  index: 'index.html',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    }
  }
}));

// Optimized database connection middleware
app.use(async (req, res, next) => {
  // Skip database check for static files and health checks
  if (req.path.startsWith('/static') || req.path === '/health' || req.path === '/') {
    return next();
  }
  
  try {
    // Only connect if not already connected
    if (mongoose.connection.readyState !== 1) {
      await connectToDatabase();
    }
    
    // Quick check - if connected, proceed immediately
    if (mongoose.connection.readyState === 1) {
      return next();
    }
    
    // If not connected, return error
    return res.status(503).json({
      success: false,
      error: 'Service Unavailable',
      message: 'Database connection not ready'
    });
    
  } catch (error) {
    logger.error('Database connection middleware error:', error);
    return res.status(503).json({
      success: false,
      error: 'Service Unavailable',
      message: 'Unable to connect to database',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// API Routes
app.use('/api', apiRoutes);

// Root route - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use(errorHandler);

// Export for Vercel
module.exports = app;

// For local testing
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  connectToDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      });
    })
    .catch((error) => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
}