#!/bin/bash

# Simple startup script for Large File Upload System
# This script provides an easy way to start the application

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Large File Upload System...${NC}"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${BLUE}📝 Creating .env file from template...${NC}"
    if [ -f "env.example" ]; then
        cp env.example .env
        echo -e "${GREEN}✅ .env file created. Please edit it with your configuration.${NC}"
    else
        echo -e "${RED}❌ env.example file not found${NC}"
        exit 1
    fi
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm install
fi

# Check MongoDB connection
echo -e "${BLUE}🔍 Checking MongoDB connection...${NC}"
if node -e "
const mongoose = require('mongoose');
const config = require('./config');
mongoose.connect(config.database.uri, {serverSelectionTimeoutMS: 5000})
  .then(() => { console.log('✅ MongoDB connected'); process.exit(0); })
  .catch(err => { console.log('❌ MongoDB connection failed:', err.message); process.exit(1); });
"; then
    echo -e "${GREEN}✅ MongoDB connection successful${NC}"
else
    echo -e "${RED}❌ MongoDB connection failed. Please check your MONGO_URI in .env file${NC}"
    exit 1
fi

# Start the application
echo -e "${BLUE}🎯 Starting application...${NC}"
echo -e "${GREEN}✅ Application will be available at: http://localhost:3000${NC}"
echo -e "${GREEN}✅ Health check: http://localhost:3000/health${NC}"
echo -e "${GREEN}✅ API endpoints: http://localhost:3000/api${NC}"
echo ""

# Start with appropriate command based on NODE_ENV
if [ "$NODE_ENV" = "development" ]; then
    npm run dev
else
    npm start
fi
