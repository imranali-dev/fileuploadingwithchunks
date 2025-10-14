#!/usr/bin/env node

// Simple API test without database dependency
const http = require('http');
const fs = require('fs');

class SimpleAPITester {
  constructor() {
    this.baseURL = 'http://localhost:3000';
    this.testResults = [];
    this.testFileId = null;
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

  async makeRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseURL);
      const options = {
        hostname: url.hostname,
        port: url.port || 3000,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const jsonBody = body ? JSON.parse(body) : {};
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: jsonBody,
              text: body
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: null,
              text: body
            });
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  async testHealthEndpoints() {
    await this.runTest('Health Check - Basic', async () => {
      const response = await this.makeRequest('GET', '/health');
      
      if (response.status !== 200) {
        throw new Error(`Health check failed with status ${response.status}`);
      }
      
      if (response.body.status !== 'OK') {
        throw new Error('Health check returned non-OK status');
      }
    });

    await this.runTest('Health Check - Detailed', async () => {
      const response = await this.makeRequest('GET', '/health/detailed');
      
      if (response.status !== 200) {
        throw new Error(`Detailed health check failed with status ${response.status}`);
      }
      
      if (!response.body.mongodb || !response.body.system) {
        throw new Error('Detailed health check missing data');
      }
    });
  }

  async testUploadInitialization() {
    await this.runTest('Upload Init - Valid Request', async () => {
      const uploadData = {
        fileName: 'test-file.txt',
        fileSize: 1024,
        mimeType: 'text/plain',
        totalChunks: 1
      };

      const response = await this.makeRequest('POST', '/api/upload/init', uploadData);

      if (response.status !== 201) {
        throw new Error(`Upload init failed with status ${response.status}`);
      }

      if (!response.body.success || !response.body.data.fileId) {
        throw new Error('Upload initialization failed');
      }

      this.testFileId = response.body.data.fileId;
    });

    await this.runTest('Upload Init - Invalid Request', async () => {
      const response = await this.makeRequest('POST', '/api/upload/init', {});

      if (response.status !== 400) {
        throw new Error('Should reject invalid request');
      }

      if (response.body.success !== false) {
        throw new Error('Should return success: false');
      }
    });

    await this.runTest('Upload Init - Oversized File', async () => {
      const uploadData = {
        fileName: 'huge-file.txt',
        fileSize: 10 * 1024 * 1024 * 1024, // 10GB
        mimeType: 'text/plain',
        totalChunks: 1
      };

      const response = await this.makeRequest('POST', '/api/upload/init', uploadData);

      if (response.status !== 400) {
        throw new Error('Should reject oversized file');
      }
    });
  }

  async testUploadStatus() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Upload Status - Valid File ID', async () => {
      const response = await this.makeRequest('GET', `/api/upload/status/${this.testFileId}`);

      if (response.status !== 200) {
        throw new Error(`Upload status check failed with status ${response.status}`);
      }

      if (!response.body.success || !response.body.data.fileId) {
        throw new Error('Upload status check failed');
      }
    });

    await this.runTest('Upload Status - Invalid File ID', async () => {
      const response = await this.makeRequest('GET', '/api/upload/status/invalid-id');

      if (response.status !== 400) {
        throw new Error('Should reject invalid file ID');
      }
    });

    await this.runTest('Upload Status - Non-existent File', async () => {
      const response = await this.makeRequest('GET', '/api/upload/status/12345678901234567890123456789012');

      if (response.status !== 404) {
        throw new Error('Should return 404 for non-existent file');
      }
    });
  }

  async testFileManagement() {
    await this.runTest('List Files - Empty List', async () => {
      const response = await this.makeRequest('GET', '/api/files');

      if (response.status !== 200) {
        throw new Error(`File listing failed with status ${response.status}`);
      }

      if (!response.body.success || !Array.isArray(response.body.data.files)) {
        throw new Error('File listing failed');
      }
    });

    await this.runTest('List Files - With Filters', async () => {
      const response = await this.makeRequest('GET', '/api/files?status=completed&page=1&limit=10');

      if (response.status !== 200) {
        throw new Error(`Filtered file listing failed with status ${response.status}`);
      }

      if (!response.body.success) {
        throw new Error('Filtered file listing failed');
      }
    });

    await this.runTest('File Stats', async () => {
      const response = await this.makeRequest('GET', '/api/files/stats');

      if (response.status !== 200) {
        throw new Error(`File stats failed with status ${response.status}`);
      }

      if (!response.body.success || typeof response.body.data.totalFiles !== 'number') {
        throw new Error('File stats failed');
      }
    });
  }

  async testErrorHandling() {
    await this.runTest('404 Handler', async () => {
      const response = await this.makeRequest('GET', '/api/nonexistent-endpoint');

      if (response.status !== 404) {
        throw new Error('404 handler failed');
      }

      if (response.body.success !== false) {
        throw new Error('404 handler should return success: false');
      }
    });
  }

  async testSecurity() {
    await this.runTest('Security Headers', async () => {
      const response = await this.makeRequest('GET', '/health');

      if (response.status !== 200) {
        throw new Error('Health check failed');
      }

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
  }

  async testFrontend() {
    await this.runTest('Frontend - Main Page', async () => {
      const response = await this.makeRequest('GET', '/');

      if (response.status !== 200) {
        throw new Error(`Frontend failed with status ${response.status}`);
      }

      if (!response.text.includes('Large File Upload System')) {
        throw new Error('Frontend not serving correctly');
      }
    });
  }

  async runAllTests() {
    console.log('🚀 Starting API Tests...\n');
    console.log(`Testing against: ${this.baseURL}`);
    
    try {
      await this.testHealthEndpoints();
      await this.testUploadInitialization();
      await this.testUploadStatus();
      await this.testFileManagement();
      await this.testErrorHandling();
      await this.testSecurity();
      await this.testFrontend();
      
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
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
  const tester = new SimpleAPITester();
  tester.runAllTests().catch(error => {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
  });
}

module.exports = SimpleAPITester;
