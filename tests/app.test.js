const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');

describe('Large File Upload System', () => {
  let mongoServer;
  let server;

  beforeAll(async () => {
    // Start in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    
    // Override the MongoDB URI for testing
    process.env.MONGO_URI = mongoUri;
    process.env.NODE_ENV = 'test';
    
    // Start the application
    server = app.getServer();
  });

  afterAll(async () => {
    // Close server and database connections
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.connection.close();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clean up database before each test
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      const collection = collections[key];
      await collection.deleteMany({});
    }
  });

  describe('Health Check', () => {
    test('GET /health should return 200', async () => {
      const response = await request(app.getApp())
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('OK');
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.uptime).toBeDefined();
    });

    test('GET /health/detailed should return detailed health info', async () => {
      const response = await request(app.getApp())
        .get('/health/detailed')
        .expect(200);

      expect(response.body.status).toBe('OK');
      expect(response.body.mongodb).toBeDefined();
      expect(response.body.memory).toBeDefined();
      expect(response.body.system).toBeDefined();
    });
  });

  describe('Upload Initialization', () => {
    test('POST /api/upload/init should create upload session', async () => {
      const uploadData = {
        fileName: 'test-file.txt',
        fileSize: 1024,
        mimeType: 'text/plain',
        totalChunks: 1
      };

      const response = await request(app.getApp())
        .post('/api/upload/init')
        .send(uploadData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.fileId).toBeDefined();
      expect(response.body.data.expiresAt).toBeDefined();
    });

    test('POST /api/upload/init should validate required fields', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/init')
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    test('POST /api/upload/init should reject oversized files', async () => {
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

      expect(response.body.success).toBe(false);
    });
  });

  describe('File Management', () => {
    test('GET /api/files should return empty list initially', async () => {
      const response = await request(app.getApp())
        .get('/api/files')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.files).toEqual([]);
      expect(response.body.data.pagination.total).toBe(0);
    });

    test('GET /api/files/stats should return file statistics', async () => {
      const response = await request(app.getApp())
        .get('/api/files/stats')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.totalFiles).toBe(0);
      expect(response.body.data.totalSize).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('GET /api/upload/status/invalid-id should return 400', async () => {
      const response = await request(app.getApp())
        .get('/api/upload/status/invalid-id')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });

    test('GET /api/upload/status/nonexistent should return 404', async () => {
      const response = await request(app.getApp())
        .get('/api/upload/status/12345678901234567890123456789012')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });

    test('POST /api/upload/complete with invalid fileId should return 400', async () => {
      const response = await request(app.getApp())
        .post('/api/upload/complete')
        .send({ fileId: 'invalid' })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Rate Limiting', () => {
    test('Should apply rate limiting to upload endpoints', async () => {
      const uploadData = {
        fileName: 'test-file.txt',
        fileSize: 1024,
        mimeType: 'text/plain',
        totalChunks: 1
      };

      // Make multiple requests quickly
      const promises = Array(25).fill().map(() =>
        request(app.getApp())
          .post('/api/upload/init')
          .send(uploadData)
      );

      const responses = await Promise.all(promises);
      
      // Some requests should be rate limited
      const rateLimitedResponses = responses.filter(r => r.status === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Security', () => {
    test('Should include security headers', async () => {
      const response = await request(app.getApp())
        .get('/health')
        .expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-xss-protection']).toBe('1; mode=block');
    });

    test('Should handle CORS preflight requests', async () => {
      const response = await request(app.getApp())
        .options('/api/upload/init')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  describe('Frontend', () => {
    test('GET / should serve the frontend', async () => {
      const response = await request(app.getApp())
        .get('/')
        .expect(200);

      expect(response.text).toContain('Large File Upload System');
      expect(response.text).toContain('<!DOCTYPE html>');
    });
  });
});
