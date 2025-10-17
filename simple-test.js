#!/usr/bin/env node

const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Simple API test script that tests the running application
class SimpleAPITester {
  constructor() {
    this.baseURL = 'http://localhost:3000';
    this.testResults = [];
    this.testFileId = null;
    this.testChunkData = Buffer.alloc(1024, 'A'); // 1KB test data
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
      const response = await fetch(`${this.baseURL}/health`);
      
      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`);
      }
      
      const data = await response.json();
      if (data.status !== 'OK') {
        throw new Error('Health check returned non-OK status');
      }
    });

    await this.runTest('Health Check - Detailed', async () => {
      const response = await fetch(`${this.baseURL}/health/detailed`);
      
      if (!response.ok) {
        throw new Error(`Detailed health check failed with status ${response.status}`);
      }
      
      const data = await response.json();
      if (!data.mongodb || !data.system) {
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

      const response = await fetch(`${this.baseURL}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(uploadData)
      });

      if (!response.ok) {
        throw new Error(`Upload init failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !data.data.fileId) {
        throw new Error('Upload initialization failed');
      }

      this.testFileId = data.data.fileId;
    });

    await this.runTest('Upload Init - Invalid Request', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      if (response.status !== 400) {
        throw new Error('Should reject invalid request');
      }

      const data = await response.json();
      if (data.success !== false) {
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

      const response = await fetch(`${this.baseURL}/api/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(uploadData)
      });

      if (response.status !== 400) {
        throw new Error('Should reject oversized file');
      }
    });
  }

  async testChunkUpload() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Chunk Upload - Valid Chunk', async () => {
      const formData = new FormData();
      formData.append('chunk', new Blob([this.testChunkData]), 'chunk-0');

      const response = await fetch(`${this.baseURL}/api/upload/chunk`, {
        method: 'POST',
        headers: {
          'x-file-id': this.testFileId,
          'x-chunk-index': '0',
          'x-total-chunks': '1'
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Chunk upload failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error('Chunk upload failed');
      }
    });

    await this.runTest('Chunk Upload - Invalid Headers', async () => {
      const formData = new FormData();
      formData.append('chunk', new Blob([this.testChunkData]), 'chunk-0');

      const response = await fetch(`${this.baseURL}/api/upload/chunk`, {
        method: 'POST',
        headers: {
          'x-file-id': 'invalid-id',
          'x-chunk-index': '0',
          'x-total-chunks': '1'
        },
        body: formData
      });

      if (response.status !== 400) {
        throw new Error('Should reject invalid file ID');
      }
    });
  }

  async testUploadCompletion() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Upload Complete - Valid Request', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileId: this.testFileId })
      });

      if (!response.ok) {
        throw new Error(`Upload completion failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error('Upload completion failed');
      }
    });

    await this.runTest('Upload Complete - Invalid File ID', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileId: 'invalid-id' })
      });

      if (response.status !== 400) {
        throw new Error('Should reject invalid file ID');
      }
    });
  }

  async testUploadStatus() {
    if (!this.testFileId) {
      throw new Error('No test file ID available');
    }

    await this.runTest('Upload Status - Valid File ID', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/status/${this.testFileId}`);

      if (!response.ok) {
        throw new Error(`Upload status check failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !data.data.fileId) {
        throw new Error('Upload status check failed');
      }
    });

    await this.runTest('Upload Status - Invalid File ID', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/status/invalid-id`);

      if (response.status !== 400) {
        throw new Error('Should reject invalid file ID');
      }
    });

    await this.runTest('Upload Status - Non-existent File', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/status/12345678901234567890123456789012`);

      if (response.status !== 404) {
        throw new Error('Should return 404 for non-existent file');
      }
    });
  }

  async testFileManagement() {
    await this.runTest('List Files - Empty List', async () => {
      const response = await fetch(`${this.baseURL}/api/files`);

      if (!response.ok) {
        throw new Error(`File listing failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !Array.isArray(data.data.files)) {
        throw new Error('File listing failed');
      }
    });

    await this.runTest('List Files - With Filters', async () => {
      const response = await fetch(`${this.baseURL}/api/files?status=completed&page=1&limit=10`);

      if (!response.ok) {
        throw new Error(`Filtered file listing failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error('Filtered file listing failed');
      }
    });

    await this.runTest('File Stats', async () => {
      const response = await fetch(`${this.baseURL}/api/files/stats`);

      if (!response.ok) {
        throw new Error(`File stats failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || typeof data.data.totalFiles !== 'number') {
        throw new Error('File stats failed');
      }
    });

    if (this.testFileId) {
      await this.runTest('Delete File - Valid File ID', async () => {
        const response = await fetch(`${this.baseURL}/api/files/${this.testFileId}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error(`File deletion failed with status ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error('File deletion failed');
        }
      });
    }
  }

  async testErrorHandling() {
    await this.runTest('404 Handler', async () => {
      const response = await fetch(`${this.baseURL}/api/nonexistent-endpoint`);

      if (response.status !== 404) {
        throw new Error('404 handler failed');
      }

      const data = await response.json();
      if (data.success !== false) {
        throw new Error('404 handler should return success: false');
      }
    });

    await this.runTest('CORS Preflight', async () => {
      const response = await fetch(`${this.baseURL}/api/upload/init`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000'
        }
      });

      if (!response.ok) {
        throw new Error('CORS preflight failed');
      }

      if (!response.headers.get('access-control-allow-origin')) {
        throw new Error('CORS headers missing');
      }
    });
  }

  async testSecurity() {
    await this.runTest('Security Headers', async () => {
      const response = await fetch(`${this.baseURL}/health`);

      if (!response.ok) {
        throw new Error('Health check failed');
      }

      const requiredHeaders = [
        'x-content-type-options',
        'x-frame-options',
        'x-xss-protection'
      ];

      for (const header of requiredHeaders) {
        if (!response.headers.get(header)) {
          throw new Error(`Missing security header: ${header}`);
        }
      }
    });
  }

  async testFrontend() {
    await this.runTest('Frontend - Main Page', async () => {
      const response = await fetch(`${this.baseURL}/`);

      if (!response.ok) {
        throw new Error(`Frontend failed with status ${response.status}`);
      }

      const text = await response.text();
      if (!text.includes('Large File Upload System')) {
        throw new Error('Frontend not serving correctly');
      }
    });
  }

  async debugProcessingFiles() {
    console.log('\n🔍 Checking for files stuck in processing...');
    
    try {
      const response = await fetch(`${this.baseURL}/api/files?status=processing`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch processing files: ${response.status}`);
      }
      
      const data = await response.json();
      const processingFiles = data.data?.files || [];
      
      console.log(`📊 Found ${processingFiles.length} files in processing status`);
      
      for (const file of processingFiles) {
        console.log(`\n📄 File: ${file.originalName}`);
        console.log(`   ID: ${file.fileId}`);
        console.log(`   Size: ${file.size} bytes`);
        console.log(`   Status: ${file.status}`);
        console.log(`   Progress: ${file.uploadedChunks}/${file.totalChunks} chunks`);
        console.log(`   Created: ${new Date(file.createdAt).toLocaleString()}`);
        console.log(`   Updated: ${new Date(file.updatedAt).toLocaleString()}`);
        
        // Check how long it's been processing
        const updatedTime = new Date(file.updatedAt);
        const now = new Date();
        const minutesStuck = Math.floor((now - updatedTime) / (1000 * 60));
        
        if (minutesStuck > 2) {
          console.log(`   ⚠️  File has been stuck for ${minutesStuck} minutes`);
          
          // Try to complete the upload again
          console.log('   🔄 Attempting to re-complete upload...');
          try {
            const completeResponse = await fetch(`${this.baseURL}/api/upload/complete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileId: file.fileId })
            });
            
            if (completeResponse.ok) {
              const result = await completeResponse.json();
              console.log(`   ✅ Re-completion result: ${result.data.status}`);
            } else {
              console.log(`   ❌ Re-completion failed: ${completeResponse.status}`);
            }
          } catch (retryError) {
            console.log(`   ❌ Re-completion error: ${retryError.message}`);
          }
        }
        
        // Check current status after retry
        const statusResponse = await fetch(`${this.baseURL}/api/upload/status/${file.fileId}`);
        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          console.log(`   Current Status: ${statusData.data.status}`);
          if (statusData.data.errorMessage) {
            console.log(`   Error: ${statusData.data.errorMessage}`);
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Debug failed:', error.message);
    }
  }

  async runAllTests() {
    console.log('🚀 Starting API Tests...\n');
    console.log(`Testing against: ${this.baseURL}`);
    
    try {
      await this.debugProcessingFiles();
      await this.testHealthEndpoints();
      await this.testUploadInitialization();
      await this.testChunkUpload();
      await this.testUploadCompletion();
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
