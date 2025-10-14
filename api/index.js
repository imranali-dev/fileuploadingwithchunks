// api/index.js - Vercel Serverless Function
// WARNING: This is a simplified version. Chunked uploads won't work properly in serverless.

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Cache MongoDB connection
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  const connection = await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  cachedDb = connection;
  return connection;
}

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Basic upload endpoint (NOT chunked - for demonstration only)
app.post('/api/upload', async (req, res) => {
  try {
    await connectToDatabase();
    
    // This is where you'd handle uploads
    // NOTE: Chunked uploads require persistent state - not possible in serverless
    
    res.json({ 
      message: 'Upload endpoint',
      warning: 'Chunked uploads not supported in serverless environment'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export for Vercel
module.exports = app;