#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

/**
 * Cleanup script for removing orphaned files and expired uploads
 */
class CleanupScript {
  constructor() {
    this.logger = require('../services/logger');
    this.fileUploadService = require('../services/fileUpload');
  }

  async run() {
    try {
      console.log('🧹 Starting cleanup process...');
      
      // Cleanup expired uploads
      console.log('Cleaning up expired uploads...');
      const expiredCount = await this.fileUploadService.cleanupExpiredUploads();
      console.log(`✅ Cleaned up ${expiredCount} expired uploads`);
      
      // Cleanup stale uploads
      console.log('Cleaning up stale uploads...');
      const staleCount = await this.fileUploadService.cleanupStaleUploads(2);
      console.log(`✅ Cleaned up ${staleCount} stale uploads`);
      
      // Cleanup orphaned chunks
      console.log('Cleaning up orphaned chunks...');
      const orphanedCount = await this.fileUploadService.cleanupOrphanedChunks();
      console.log(`✅ Cleaned up ${orphanedCount} orphaned chunk directories`);
      
      // Cleanup old log files
      console.log('Cleaning up old log files...');
      const logCount = await this.cleanupOldLogs();
      console.log(`✅ Cleaned up ${logCount} old log files`);
      
      console.log('🎉 Cleanup process completed successfully!');
      
    } catch (error) {
      console.error('❌ Cleanup process failed:', error.message);
      process.exit(1);
    }
  }

  async cleanupOldLogs() {
    try {
      const logDir = config.logging.directory;
      if (!await this.directoryExists(logDir)) {
        return 0;
      }

      const files = await fs.readdir(logDir);
      let cleanedCount = 0;
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      for (const file of files) {
        const filePath = path.join(logDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime < cutoffDate) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error('Error cleaning up log files:', error.message);
      return 0;
    }
  }

  async directoryExists(dirPath) {
    try {
      await fs.access(dirPath);
      return true;
    } catch {
      return false;
    }
  }
}

// Run the cleanup script
if (require.main === module) {
  const cleanup = new CleanupScript();
  cleanup.run();
}

module.exports = CleanupScript;
