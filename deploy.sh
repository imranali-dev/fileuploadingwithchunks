#!/bin/bash

# Deployment script for Large File Upload System
# This script handles the complete deployment process

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="large-file-upload-system"
DOCKER_IMAGE="large-file-upload"
DOCKER_TAG="latest"
PORT=${PORT:-3000}
ENVIRONMENT=${NODE_ENV:-production}

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required tools are installed
check_dependencies() {
    log_info "Checking dependencies..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi
    
    # Docker deployment removed - using Node.js only
    
    log_success "Dependencies checked"
}

# Validate environment
validate_environment() {
    log_info "Validating environment..."
    
    if [ ! -f ".env" ]; then
        log_warning ".env file not found. Creating from template..."
        if [ -f "env.example" ]; then
            cp env.example .env
            log_warning "Please edit .env file with your configuration"
        else
            log_error "env.example file not found"
            exit 1
        fi
    fi
    
    # Check required environment variables
    if [ -z "$MONGO_URI" ]; then
        log_error "MONGO_URI environment variable is required"
        exit 1
    fi
    
    log_success "Environment validated"
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    
    npm ci --only=production
    
    log_success "Dependencies installed"
}

# Run tests
run_tests() {
    log_info "Running tests..."
    
    if npm test; then
        log_success "All tests passed"
    else
        log_error "Tests failed"
        exit 1
    fi
}

# Run linting
run_linting() {
    log_info "Running linting..."
    
    if npm run lint; then
        log_success "Linting passed"
    else
        log_warning "Linting issues found. Attempting to fix..."
        npm run lint:fix
    fi
}

# Docker deployment functions removed

# Deploy directly with Node.js
deploy_node() {
    log_info "Deploying with Node.js..."
    
    # Stop existing process if running
    pkill -f "node.*app.js" 2>/dev/null || true
    
    # Start application
    nohup npm start > app.log 2>&1 &
    
    # Wait for application to start
    log_info "Waiting for application to start..."
    sleep 5
    
    # Check health
    if curl -f http://localhost:$PORT/health > /dev/null 2>&1; then
        log_success "Application is healthy"
    else
        log_error "Application health check failed"
        cat app.log
        exit 1
    fi
    
    log_success "Node.js deployment completed"
}

# Setup monitoring
setup_monitoring() {
    log_info "Setting up monitoring..."
    
    # Create log directory
    mkdir -p logs
    
    # Set up log rotation (if logrotate is available)
    if command -v logrotate &> /dev/null; then
        cat > /etc/logrotate.d/$APP_NAME << EOF
$(pwd)/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 644 root root
}
EOF
        log_success "Log rotation configured"
    fi
    
    # Set up systemd service (if systemd is available)
    if command -v systemctl &> /dev/null; then
        cat > /etc/systemd/system/$APP_NAME.service << EOF
[Unit]
Description=Large File Upload System
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
Environment=NODE_ENV=$ENVIRONMENT

[Install]
WantedBy=multi-user.target
EOF
        
        systemctl daemon-reload
        systemctl enable $APP_NAME
        log_success "Systemd service configured"
    fi
}

# Cleanup old deployments
cleanup() {
    log_info "Cleaning up old deployments..."
    
    # Docker cleanup removed
    
    # Clean up old logs
    find logs -name "*.log" -mtime +30 -delete 2>/dev/null || true
    
    # Clean up old uploads
    find uploads -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
    
    log_success "Cleanup completed"
}

# Main deployment function
deploy() {
    local deployment_method=${1:-"node"}
    
    log_info "Starting deployment of $APP_NAME..."
    log_info "Environment: $ENVIRONMENT"
    log_info "Port: $PORT"
    log_info "Deployment method: $deployment_method"
    
    check_dependencies
    validate_environment
    install_dependencies
    run_linting
    
    # Only run tests in non-production environments
    if [ "$ENVIRONMENT" != "production" ]; then
        run_tests
    fi
    
    case $deployment_method in
        "node")
            deploy_node
            ;;
        *)
            log_error "Unknown deployment method: $deployment_method"
            log_info "Available methods: node"
            exit 1
            ;;
    esac
    
    setup_monitoring
    cleanup
    
    log_success "Deployment completed successfully!"
    log_info "Application is running at: http://localhost:$PORT"
    log_info "Health check: http://localhost:$PORT/health"
}

# Show usage
usage() {
    echo "Usage: $0 [deployment_method]"
    echo ""
    echo "Deployment methods:"
    echo "  node           Deploy directly with Node.js"
    echo ""
    echo "Environment variables:"
    echo "  NODE_ENV       Environment (default: production)"
    echo "  PORT           Port number (default: 3000)"
    echo "  MONGO_URI      MongoDB connection string (required)"
    echo ""
    echo "Examples:"
    echo "  $0"
    echo "  NODE_ENV=development $0"
    echo "  PORT=8080 $0"
}

# Handle command line arguments
case "${1:-}" in
    "help"|"-h"|"--help")
        usage
        exit 0
        ;;
    *)
        deploy "${1:-node}"
        ;;
esac
