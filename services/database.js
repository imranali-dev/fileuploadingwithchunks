const mongoose = require('mongoose');
const config = require('../config');
const logger = require('./logger');
const { DatabaseError, NetworkError, TimeoutError } = require('../utils/errors');

class DatabaseService {
  constructor() {
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = config.upload.maxRetries;
    this.retryDelay = config.upload.retryDelay;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    mongoose.connection.on('connected', () => {
      this.isConnected = true;
      this.connectionAttempts = 0;
      logger.logDatabase('connected', {
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name
      });
    });

    mongoose.connection.on('error', (err) => {
      this.isConnected = false;
      logger.logDatabaseError('connection', err);
    });

    mongoose.connection.on('disconnected', () => {
      this.isConnected = false;
      logger.logDatabase('disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      this.isConnected = true;
      logger.logDatabase('reconnected');
    });

    mongoose.connection.on('close', () => {
      this.isConnected = false;
      logger.logDatabase('connection closed');
    });
  }

  async connect() {
    const startTime = Date.now();
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.connectionAttempts = attempt;
        
        logger.logDatabase('connection attempt', {
          attempt: `${attempt}/${this.maxRetries}`,
          uri: this.sanitizeUri(config.database.uri)
        });

        await mongoose.connect(config.database.uri, {
          dbName: config.database.dbName,
          maxPoolSize: config.database.maxPoolSize,
          minPoolSize: config.database.minPoolSize,
          serverSelectionTimeoutMS: config.database.serverSelectionTimeout,
          socketTimeoutMS: config.database.socketTimeout,
          connectTimeoutMS: config.database.connectTimeout,
          retryWrites: config.database.retryWrites,
          retryReads: config.database.retryReads,
          bufferCommands: false // Disable buffering to ensure connection is ready
        });

        const duration = Date.now() - startTime;
        logger.logPerformance('database connection', duration, {
          attempt,
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name
        });

        return true;

      } catch (error) {
        logger.logDatabaseError('connection attempt', error, {
          attempt: `${attempt}/${this.maxRetries}`,
          uri: this.sanitizeUri(config.database.uri)
        });

        if (attempt === this.maxRetries) {
          const duration = Date.now() - startTime;
          throw new DatabaseError(
            `Failed to connect to MongoDB after ${this.maxRetries} attempts: ${error.message}`,
            'connect'
          );
        }

        // Exponential backoff
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        logger.logDatabase('retry delay', { delay: `${delay}ms` });
        await this.sleep(delay);
      }
    }
  }

  async disconnect() {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        logger.logDatabase('disconnected gracefully');
      }
    } catch (error) {
      logger.logDatabaseError('disconnect', error);
      throw new DatabaseError('Failed to disconnect from database', 'disconnect');
    }
  }

  async healthCheck() {
    try {
      if (!this.isConnected) {
        return {
          status: 'disconnected',
          readyState: mongoose.connection.readyState,
          error: 'Not connected to database'
        };
      }

      // Ping the database
      const startTime = Date.now();
      await mongoose.connection.db.admin().ping();
      const duration = Date.now() - startTime;

      return {
        status: 'healthy',
        readyState: mongoose.connection.readyState,
        ping: 'success',
        responseTime: `${duration}ms`,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name,
        collections: await this.getCollectionStats()
      };

    } catch (error) {
      logger.logDatabaseError('health check', error);
      return {
        status: 'unhealthy',
        readyState: mongoose.connection.readyState,
        ping: 'failed',
        error: error.message
      };
    }
  }

  async getCollectionStats() {
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      const stats = {};

      for (const collection of collections) {
        try {
          const collectionStats = await mongoose.connection.db.collection(collection.name).stats();
          stats[collection.name] = {
            count: collectionStats.count,
            size: collectionStats.size,
            avgObjSize: collectionStats.avgObjSize,
            storageSize: collectionStats.storageSize,
            indexes: collectionStats.nindexes
          };
        } catch (error) {
          stats[collection.name] = { error: error.message };
        }
      }

      return stats;
    } catch (error) {
      logger.logDatabaseError('collection stats', error);
      return { error: error.message };
    }
  }

  async createIndexes() {
    try {
      logger.logDatabase('creating indexes');
      
      // FileUpload indexes
      const FileUpload = mongoose.model('FileUpload');
      await FileUpload.createIndexes();
      
      logger.logDatabase('indexes created successfully');
    } catch (error) {
      logger.logDatabaseError('create indexes', error);
      throw new DatabaseError('Failed to create database indexes', 'createIndexes');
    }
  }

  async dropDatabase() {
    try {
      if (config.server.isTest) {
        await mongoose.connection.db.dropDatabase();
        logger.logDatabase('database dropped');
      } else {
        throw new DatabaseError('Database drop is only allowed in test environment', 'dropDatabase');
      }
    } catch (error) {
      logger.logDatabaseError('drop database', error);
      throw new DatabaseError('Failed to drop database', 'dropDatabase');
    }
  }

  async backupDatabase() {
    try {
      // This is a placeholder for database backup functionality
      // In production, you would implement actual backup logic
      logger.logDatabase('backup initiated');
      
      // Example backup logic would go here
      const collections = await mongoose.connection.db.listCollections().toArray();
      
      logger.logDatabase('backup completed', {
        collections: collections.length
      });
      
      return {
        success: true,
        collections: collections.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.logDatabaseError('backup', error);
      throw new DatabaseError('Failed to backup database', 'backup');
    }
  }

  // Utility methods
  sanitizeUri(uri) {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getConnectionState() {
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    
    return {
      readyState: mongoose.connection.readyState,
      state: states[mongoose.connection.readyState],
      isConnected: this.isConnected,
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name
    };
  }

  // Transaction support
  async withTransaction(fn) {
    const session = await mongoose.startSession();
    
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      
      return result;
    } catch (error) {
      logger.logDatabaseError('transaction', error);
      throw new DatabaseError('Transaction failed', 'transaction');
    } finally {
      await session.endSession();
    }
  }

  // Graceful shutdown
  async gracefulShutdown() {
    try {
      logger.logDatabase('graceful shutdown initiated');
      
      // Close all connections
      await mongoose.connection.close();
      
      logger.logDatabase('graceful shutdown completed');
    } catch (error) {
      logger.logDatabaseError('graceful shutdown', error);
      throw new DatabaseError('Failed to shutdown database gracefully', 'shutdown');
    }
  }
}

module.exports = new DatabaseService();
