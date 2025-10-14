# 🚀 Large File Upload System

A production-ready, scalable file upload system built with Node.js, Express, MongoDB, and GridFS. Supports chunked uploads for files up to 5GB with comprehensive error handling, security features, and monitoring.

## ✨ Features

### Core Features
- **Chunked Upload**: Upload large files in 50MB chunks for better reliability
- **Resumable Uploads**: Resume interrupted uploads automatically
- **GridFS Storage**: Efficient storage of large files in MongoDB
- **Real-time Progress**: Live upload progress tracking
- **File Management**: List, download, and delete uploaded files

### Production Features
- **Comprehensive Error Handling**: Custom error classes and middleware
- **Security**: Rate limiting, CORS, helmet, input validation
- **Logging**: Structured logging with Winston and daily rotation
- **Health Monitoring**: Health check endpoints and system monitoring
- **Cleanup Services**: Automatic cleanup of expired and orphaned files
- **Deployment Scripts**: Automated deployment with health monitoring
- **Environment Configuration**: Flexible configuration management

### Technical Features
- **Modular Architecture**: Clean separation of concerns
- **Database Connection Pooling**: Optimized MongoDB connections
- **Request Validation**: Joi-based input validation
- **File Type Validation**: Configurable MIME type restrictions
- **Retry Logic**: Automatic retry for failed operations
- **Graceful Shutdown**: Proper cleanup on application termination

## 🏗️ Architecture

```
large-file-upload-system/
├── config/                 # Configuration management
│   └── index.js           # Environment configuration
├── controllers/           # Request handlers
│   └── index.js           # Upload, File, and Health controllers
├── middleware/            # Express middleware
│   ├── validation.js      # Request validation middleware
│   └── security.js        # Security and rate limiting middleware
├── models/                # Database models
│   └── FileUpload.js      # File upload schema and methods
├── routes/                # API routes
│   └── api.js             # API endpoint definitions
├── services/              # Business logic services
│   ├── database.js        # Database connection and health
│   ├── fileUpload.js      # File upload business logic
│   └── logger.js          # Logging service
├── utils/                 # Utility functions
│   └── errors.js          # Custom error classes and handlers
├── scripts/               # Utility scripts
│   └── cleanup.js         # Cleanup script for maintenance
├── tests/                 # Test files
├── logs/                  # Log files (created at runtime)
├── uploads/               # Temporary chunk storage
├── app.js                 # Main application entry point
├── server.js              # Legacy server (for reference)
├── index.html             # Frontend interface
├── package.json           # Dependencies and scripts
├── deploy.sh              # Deployment script
└── README.md              # This file
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- MongoDB 5.0+
- npm 9.0+

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd large-file-upload-system
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start the application**
   ```bash
   # Development
   npm run dev
   
   # Production
   npm run prod
   ```

5. **Access the application**
   - Frontend: http://localhost:3000
   - API: http://localhost:3000/api
   - Health Check: http://localhost:3000/health

### Production Deployment

1. **Using the deployment script (Recommended)**
   ```bash
   ./deploy.sh
   ```

2. **Manual deployment**
   ```bash
   npm run prod
   ```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `MONGO_URI` | MongoDB connection string | Required |
| `UPLOAD_DIR` | Upload directory | `./uploads` |
| `CHUNK_SIZE_LIMIT` | Maximum chunk size | `52428800` (50MB) |
| `TOTAL_SIZE_LIMIT` | Maximum file size | `5368709120` (5GB) |
| `FILE_EXPIRY_HOURS` | File expiration time | `24` |
| `ALLOWED_ORIGINS` | CORS allowed origins | `*` |
| `LOG_LEVEL` | Logging level | `info` |

### Security Configuration

- **Rate Limiting**: Configurable per endpoint
- **CORS**: Configurable origins and headers
- **Helmet**: Security headers
- **Input Validation**: Joi-based validation
- **File Type Validation**: Configurable MIME types

## 📡 API Endpoints

### Upload Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload/init` | Initialize upload session |
| `POST` | `/api/upload/chunk` | Upload file chunk |
| `POST` | `/api/upload/complete` | Complete upload |
| `GET` | `/api/upload/status/:fileId` | Get upload status |
| `POST` | `/api/upload/cancel` | Cancel upload |

### File Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files` | List files |
| `GET` | `/api/files/stats` | Get file statistics |
| `GET` | `/api/download/:fileId` | Download file |
| `DELETE` | `/api/files/:fileId` | Delete file |

### Health & Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Basic health check |
| `GET` | `/health/detailed` | Detailed health information |

## 🔧 Development

### Available Scripts

```bash
npm run start          # Start production server
npm run dev            # Start development server with nodemon
npm run dev:debug      # Start with debugging enabled
npm run prod           # Start production server
npm run legacy         # Start legacy server.js
npm run test           # Run tests
npm run test:watch     # Run tests in watch mode
npm run lint           # Run ESLint
npm run lint:fix       # Fix ESLint issues
npm run format         # Format code with Prettier
npm run validate       # Run linting and tests
npm run cleanup        # Run cleanup script
npm run logs:clear     # Clear log files
npm run health-check   # Check application health
npm run setup          # Install dependencies and validate
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm test -- --coverage
```

### Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Validate everything
npm run validate
```

## 🐳 Deployment

### Production Deployment

The application can be deployed using the provided deployment script:

```bash
# Deploy with default settings
./deploy.sh

# Deploy with custom environment
NODE_ENV=production PORT=8080 ./deploy.sh

# Deploy in development mode
NODE_ENV=development ./deploy.sh
```

### Deployment Script Features

- **Dependency checking**: Verifies Node.js and npm are installed
- **Environment validation**: Checks required environment variables
- **Dependency installation**: Installs production dependencies
- **Code quality checks**: Runs linting and tests
- **Health monitoring**: Sets up systemd service and log rotation
- **Cleanup**: Removes old logs and temporary files

## 📊 Monitoring

### Health Checks

- **Basic Health**: `/health` - Quick health status
- **Detailed Health**: `/health/detailed` - Comprehensive system status

### Logging

- **Structured Logging**: JSON format with metadata
- **Log Rotation**: Daily rotation with size limits
- **Multiple Levels**: error, warn, info, debug
- **Request Logging**: Automatic request/response logging

### Metrics

- Upload statistics
- File storage metrics
- Database performance
- System resource usage

## 🔒 Security

### Implemented Security Features

- **Rate Limiting**: Per-IP and per-endpoint limits
- **CORS Protection**: Configurable cross-origin policies
- **Input Validation**: Comprehensive request validation
- **File Type Validation**: MIME type restrictions
- **Security Headers**: Helmet.js security headers
- **Error Handling**: Secure error responses
- **Request Size Limits**: Protection against large requests

### Security Best Practices

1. **Environment Variables**: Never commit sensitive data
2. **HTTPS**: Use HTTPS in production
3. **Authentication**: Implement user authentication
4. **Authorization**: Add role-based access control
5. **Monitoring**: Monitor for suspicious activity
6. **Updates**: Keep dependencies updated

## 🚨 Error Handling

### Error Types

- **ValidationError**: Input validation failures
- **UploadError**: File upload specific errors
- **DatabaseError**: Database operation failures
- **FileSystemError**: File system operation failures
- **NetworkError**: Network connectivity issues
- **TimeoutError**: Request timeout errors

### Error Response Format

```json
{
  "success": false,
  "error": "Error message",
  "type": "error_type",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "path": "/api/upload/init",
  "method": "POST"
}
```

## 🧹 Maintenance

### Cleanup Scripts

```bash
# Run cleanup manually
npm run cleanup

# Or run the script directly
node scripts/cleanup.js
```

### Cleanup Tasks

- **Expired Uploads**: Remove files past expiration
- **Stale Uploads**: Remove abandoned uploads
- **Orphaned Chunks**: Remove unused chunk directories
- **Old Logs**: Remove old log files

### Automated Cleanup

- Expired uploads: Every hour
- Stale uploads: Every 2 hours
- Orphaned chunks: Every 6 hours
- Log rotation: Daily

## 📈 Performance

### Optimization Features

- **Connection Pooling**: Optimized database connections
- **Chunked Uploads**: Efficient large file handling
- **GridFS**: Optimized file storage
- **Compression**: Response compression
- **Caching**: Configurable caching strategies

### Performance Monitoring

- Upload speed tracking
- Database query performance
- Memory usage monitoring
- Response time tracking

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

### Development Guidelines

- Follow ESLint configuration
- Write comprehensive tests
- Update documentation
- Use conventional commits
- Ensure backward compatibility

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

### Troubleshooting

1. **Check logs**: Review application logs for errors
2. **Health check**: Use `/health` endpoint to verify status
3. **Database**: Ensure MongoDB is running and accessible
4. **Permissions**: Check file system permissions
5. **Configuration**: Verify environment variables

### Common Issues

- **Port already in use**: Change PORT environment variable
- **Database connection**: Check MONGO_URI configuration
- **File permissions**: Ensure upload directory is writable
- **Memory issues**: Increase Node.js memory limit

### Getting Help

- Check the logs in the `logs/` directory
- Use the health check endpoints
- Review the configuration
- Check MongoDB connection
- Verify file system permissions

---

**Built with ❤️ for handling large file uploads efficiently and reliably.**
# fileuploadingwithchunks
