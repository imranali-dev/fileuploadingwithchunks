#!/usr/bin/env node

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Import the app
const app = require('./app');

// Test configuration
const TEST_CONFIG = {
  API_BASE: 'http://localhost:3000/api',
  TEST_FILE_SIZE: 1024 * 1024, // 1MB test file
  CHUNK_SIZE: 50 * 1024 * 1024, // 50MB chunks
  TIMEOUT: 30000
};

class APITester {
  constructor() {
    this.mongoServer = null;
    this.testResults = [];
    this.testFileId = null;
    this.testChunkData = Buffer.alloc(TEST_CONFIG.TEST_FILE_SIZE, 'A');
  }

  async setup() {
    console.log('🔧 Setting up test environment...');
    
    // Start in-memory MongoDB
    this.mongoServer = await MongoMemoryServer.create();
    const mongoUri = this.mongoServer.getUri();
    
    // Override MongoDB URI for testing
    process.env.MONGO_URI = mongoUri;
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3001'; // Use different port for testing
    
    console.log('✅ Test environment setup complete');
  }

  async cleanup() {
    console.log('🧹 Cleaning up test environment...');
    
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    
    if (this.mongoServer) {
      await this.mongoServer.stop();
    }
    
    console.log('✅ Cleanup complete');
  }

  async runTest(testName, testFunction) {
    console.log(`\n🧪 Running test: ${testName}`);
    
    try {
      const startTime = Date.now();
      await testFunction();
      const duration = Date.now() - startTime;
      
      this.testResults.push({
        name: testName,
        status: 'PASS',
        duration: `${duration}ms`
      });
      
      console.log(`✅ ${testName} - PASSED (${duration}ms)`);
    } catch (error) {
      this.testResults.push({
        name: testName,
        status: 'FAIL',
        error: error.message
      });
      
      console.log(`❌ ${testName} - FAILED: ${error.message}`);
    }
  }

  async testHealthEndpoints() {
    await this.runTest('Health Check - Basic', async () => {
      const response = await request(app.getApp())
        .get('/health')
        .expect(200);

      if (response.body.status !== 'OK') {
        throw new Error('Health check failed');
      }
    });

    await this.runTest('Health Check - Detailed', async () => {
      const response = await request(app.getApp())
        .get('/health/detailed')
        .expect(200);

      if (!response.body.mongodb || !response.body.system) {
        throw new Error('Detailed health check missing data');
      }
    });
  }

  async testUploadInitialization() {
    await this.runTest('Upload Init - Valid Request', async () => {
      const uploadData = {
        fileName: 'test-file.txt',
        fileSize: TEST_CONFIG.TEST_FILE_SIZE,
        mimeType: 'text/plain',
        totalChunks: Math.ceil(TEST_CONFIG.TEST_FILE_SIZE / TEST_CONFIG.CHUNK_SIZE)
      };

      const response = await request(app.getApp())
        .post('/api/upload/init')
        .send(uploadData)
        .expect(201);

      if (!response.body.success || !response.body.data.fileId) {
        throw new Error('Upload initialization failed');
      }

      this.testFileId = response.body.data.fileId;
    });

    await this.runTest('Upload Init - Invalid Request', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/init')
        .send({})
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject invalid request');
      }
    });

    await this.runTest('Upload Init - Oversized File', async () => {
      const uploadData = {
        fileName: 'huge-file.txt',
        fileSize: 10 * 1024 * 1024 * 1024, // 10GB
        mimeType: 'text/plain',
        totalChunks: 1
      };

      const response = await request(app.getApp())
        .post('/api/upload/init')
        .send(uploadData)
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject oversized file');
      }
    });
  }

  async testChunkUpload() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Chunk Upload - Valid Chunk', async () => {
      const totalChunks = Math.ceil(TEST_CONFIG.TEST_FILE_SIZE / TEST_CONFIG.CHUNK_SIZE);
      
      const response = await request(app.getApp())
        .post('/api/upload/chunk')
        .set('x-file-id', this.testFileId)
        .set('x-chunk-index', '0')
        .set('x-total-chunks', totalChunks.toString())
        .attach('chunk', this.testChunkData, 'chunk-0')
        .expect(200);

      if (!response.body.success) {
        throw new Error('Chunk upload failed');
      }
    });

    await this.runTest('Chunk Upload - Invalid Headers', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/chunk')
        .set('x-file-id', 'invalid-id')
        .set('x-chunk-index', '0')
        .set('x-total-chunks', '1')
        .attach('chunk', this.testChunkData, 'chunk-0')
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject invalid file ID');
      }
    });

    await this.runTest('Chunk Upload - Missing File', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/chunk')
        .set('x-file-id', this.testFileId)
        .set('x-chunk-index', '0')
        .set('x-total-chunks', '1')
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject missing file');
      }
    });
  }

  async testUploadCompletion() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Upload Complete - Valid Request', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/complete')
        .send({ fileId: this.testFileId })
        .expect(200);

      if (!response.body.success) {
        throw new Error('Upload completion failed');
      }
    });

    await this.runTest('Upload Complete - Invalid File ID', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/complete')
        .send({ fileId: 'invalid-id' })
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject invalid file ID');
      }
    });
  }

  async testUploadStatus() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Upload Status - Valid File ID', async () => {
      const response = await request(app.getApp())
        .get(`/api/upload/status/${this.testFileId}`)
        .expect(200);

      if (!response.body.success || !response.body.data.fileId) {
        throw new Error('Upload status check failed');
      }
    });

    await this.runTest('Upload Status - Invalid File ID', async () => {
      const response = await request(app.getApp())
        .get('/api/upload/status/invalid-id')
        .expect(400);

      if (response.body.success !== false) {
        throw new Error('Should reject invalid file ID');
      }
    });

    await this.runTest('Upload Status - Non-existent File', async () => {
      const response = await request(app.getApp())
        .get('/api/upload/status/12345678901234567890123456789012')
        .expect(404);

      if (response.body.success !== false) {
        throw new Error('Should return 404 for non-existent file');
      }
    });
  }

  async testFileManagement() {
    await this.runTest('List Files - Empty List', async () => {
      const response = await request(app.getApp())
        .get('/api/files')
        .expect(200);

      if (!response.body.success || !Array.isArray(response.body.data.files)) {
        throw new Error('File listing failed');
      }
    });

    await this.runTest('List Files - With Filters', async () => {
      const response = await request(app.getApp())
        .get('/api/files?status=completed&page=1&limit=10')
        .expect(200);

      if (!response.body.success) {
        throw new Error('Filtered file listing failed');
      }
    });

    await this.runTest('File Stats', async () => {
      const response = await request(app.getApp())
        .get('/api/files/stats')
        .expect(200);

      if (!response.body.success || typeof response.body.data.totalFiles !== 'number') {
        throw new Error('File stats failed');
      }
    });

    if (this.testFileId) {
      await this.runTest('Delete File - Valid File ID', async () => {
        const response = await request(app.getApp())
          .delete(`/api/files/${this.testFileId}`)
          .expect(200);

        if (!response.body.success) {
          throw new Error('File deletion failed');
        }
      });
    }
  }

  async testErrorHandling() {
    await this.runTest('404 Handler', async () => {
      const response = await request(app.getApp())
        .get('/api/nonexistent-endpoint')
        .expect(404);

      if (response.body.success !== false) {
        throw new Error('404 handler failed');
      }
    });

    await this.runTest('CORS Preflight', async () => {
      const response = await request(app.getApp())
        .options('/api/upload/init')
        .expect(200);

      if (!response.headers['access-control-allow-origin']) {
        throw new Error('CORS headers missing');
      }
    });
  }

  async testSecurity() {
    await this.runTest('Security Headers', async () => {
      const response = await request(app.getApp())
        .get('/health')
        .expect(200);

      const requiredHeaders = [
        'x-content-type-options',
        'x-frame-options',
        'x-xss-protection'
      ];

      for (const header of requiredHeaders) {
        if (!response.headers[header]) {
          throw new Error(`Missing security header: ${header}`);
        }
      }
    });

    await this.runTest('Rate Limiting', async () => {
      // Make multiple requests quickly to trigger rate limiting
      const promises = Array(25).fill().map(() =>
        request(app.getApp())
          .post('/api/upload/init')
          .send({
            fileName: 'test.txt',
            fileSize: 1024,
            mimeType: 'text/plain',
            totalChunks: 1
          })
      );

      const responses = await Promise.all(promises);
      const rateLimitedResponses = responses.filter(r => r.status === 429);
      
      if (rateLimitedResponses.length === 0) {
        throw new Error('Rate limiting not working');
      }
    });
  }

  async testFrontend() {
    await this.runTest('Frontend - Main Page', async () => {
      const response = await request(app.getApp())
        .get('/')
        .expect(200);

      if (!response.text.includes('Large File Upload System')) {
        throw new Error('Frontend not serving correctly');
      }
    });
  }

  async runAllTests() {
    console.log('🚀 Starting API Tests...\n');
    
    try {
      await this.setup();
      
      // Wait for app to be ready
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.testHealthEndpoints();
      await this.testUploadInitialization();
      await this.testChunkUpload();
      await this.testUploadCompletion();
      await this.testUploadStatus();
      await this.testFileManagement();
      await this.testErrorHandling();
      await this.testSecurity();
      await this.testFrontend();
      
    } finally {
      await this.cleanup();
    }

    this.printResults();
  }

  printResults() {
    console.log('\n📊 Test Results Summary:');
    console.log('=' .repeat(50));
    
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    const total = this.testResults.length;
    
    console.log(`Total Tests: ${total}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
      console.log('\n❌ Failed Tests:');
      this.testResults
        .filter(r => r.status === 'FAIL')
        .forEach(test => {
          console.log(`  - ${test.name}: ${test.error}`);
        });
    }
    
    console.log('\n✅ All Tests Completed!');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const tester = new APITester();
  tester.runAllTests().catch(error => {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
  });
}

module.exports = APITester;
