#!/bin/bash

# Order Processing Service Deployment Script
# This script handles building and deploying the order processing service

set -e

# Configuration
SERVICE_NAME="order-processing-service"
IMAGE_NAME="order-processing"
CONTAINER_PORT=8000
HEALTH_CHECK_PATH="/health"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if required tools are installed
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed or not in PATH"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed or not in PATH"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Function to build Docker image
build_image() {
    log_info "Building Docker image: $IMAGE_NAME"
    
    docker build -t $IMAGE_NAME:latest .
    
    if [ $? -eq 0 ]; then
        log_info "Docker image built successfully"
    else
        log_error "Failed to build Docker image"
        exit 1
    fi
}

# Function to run tests
run_tests() {
    log_info "Running tests..."
    
    # Create test network if it doesn't exist
    docker network create test-network 2>/dev/null || true
    
    # Start test MongoDB
    docker run -d --name test-mongodb --network test-network \
        -e MONGO_INITDB_DATABASE=test_orders \
        mongo:7.0 2>/dev/null || docker start test-mongodb
    
    # Wait for MongoDB to be ready
    sleep 10
    
    # Run tests
    docker run --rm --network test-network \
        -e MONGODB_URL=mongodb://test-mongodb:27017/test_orders \
        -e PRODUCT_SERVICE_URL=http://mock-service:5000 \
        -e AUTH_SERVICE_URL=http://mock-service:8080 \
        $IMAGE_NAME:latest python -m pytest tests/ -v
    
    # Cleanup
    docker stop test-mongodb 2>/dev/null || true
    docker rm test-mongodb 2>/dev/null || true
    docker network rm test-network 2>/dev/null || true
    
    log_info "Tests completed"
}

# Function to deploy locally
deploy_local() {
    log_info "Deploying locally with Docker Compose..."
    
    # Stop existing containers
    docker-compose down 2>/dev/null || true
    
    # Start services
    docker-compose up -d
    
    # Wait for services to be ready
    log_info "Waiting for services to be ready..."
    sleep 30
    
    # Health check
    if curl -f http://localhost:$CONTAINER_PORT$HEALTH_CHECK_PATH > /dev/null 2>&1; then
        log_info "Service is healthy and ready"
        log_info "API documentation available at: http://localhost:$CONTAINER_PORT/docs"
    else
        log_error "Service health check failed"
        docker-compose logs order-processing
        exit 1
    fi
}

# Function to deploy to production (placeholder)
deploy_production() {
    log_info "Deploying to production..."
    
    # This would typically involve:
    # 1. Pushing image to ECR
    # 2. Updating ECS service
    # 3. Waiting for deployment to complete
    # 4. Running health checks
    
    log_warn "Production deployment not implemented in this script"
    log_info "For production deployment, use AWS CDK or Terraform"
}

# Function to show service status
show_status() {
    log_info "Service Status:"
    docker-compose ps
    
    echo ""
    log_info "Service Logs (last 20 lines):"
    docker-compose logs --tail=20 order-processing
}

# Function to cleanup
cleanup() {
    log_info "Cleaning up..."
    docker-compose down
    docker system prune -f
    log_info "Cleanup completed"
}

# Main script logic
case "${1:-local}" in
    "build")
        check_prerequisites
        build_image
        ;;
    "test")
        check_prerequisites
        build_image
        run_tests
        ;;
    "local")
        check_prerequisites
        build_image
        deploy_local
        ;;
    "production")
        check_prerequisites
        build_image
        deploy_production
        ;;
    "status")
        show_status
        ;;
    "cleanup")
        cleanup
        ;;
    *)
        echo "Usage: $0 {build|test|local|production|status|cleanup}"
        echo ""
        echo "Commands:"
        echo "  build      - Build Docker image only"
        echo "  test       - Build image and run tests"
        echo "  local      - Deploy locally with Docker Compose"
        echo "  production - Deploy to production (placeholder)"
        echo "  status     - Show service status and logs"
        echo "  cleanup    - Stop services and cleanup"
        exit 1
        ;;
esac

log_info "Deployment script completed successfully"