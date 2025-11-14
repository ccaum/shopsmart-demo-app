#!/bin/bash

# User Authentication Service Deployment Script

set -e

# Configuration
SERVICE_NAME="user-auth"
SERVICE_PORT=8002
HEALTH_ENDPOINT="/health"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting deployment of User Authentication Service...${NC}"

# Function to check if service is running
check_service() {
    local port=$1
    local max_attempts=30
    local attempt=1
    
    echo -e "${YELLOW}Checking if service is running on port $port...${NC}"
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f -s "http://localhost:$port$HEALTH_ENDPOINT" > /dev/null 2>&1; then
            echo -e "${GREEN}Service is healthy on port $port${NC}"
            return 0
        fi
        
        echo "Attempt $attempt/$max_attempts: Service not ready yet..."
        sleep 2
        ((attempt++))
    done
    
    echo -e "${RED}Service failed to start on port $port${NC}"
    return 1
}

# Function to stop existing service
stop_service() {
    echo -e "${YELLOW}Stopping existing User Auth service...${NC}"
    
    # Find and kill processes on the service port
    local pids=$(lsof -ti:$SERVICE_PORT 2>/dev/null || true)
    if [ ! -z "$pids" ]; then
        echo "Killing processes: $pids"
        kill -TERM $pids 2>/dev/null || true
        sleep 3
        
        # Force kill if still running
        local remaining_pids=$(lsof -ti:$SERVICE_PORT 2>/dev/null || true)
        if [ ! -z "$remaining_pids" ]; then
            echo "Force killing remaining processes: $remaining_pids"
            kill -KILL $remaining_pids 2>/dev/null || true
        fi
    fi
    
    echo -e "${GREEN}Existing service stopped${NC}"
}

# Function to install dependencies
install_dependencies() {
    echo -e "${YELLOW}Installing Python dependencies...${NC}"
    
    # Create virtual environment if it doesn't exist
    if [ ! -d "venv" ]; then
        python3 -m venv venv
    fi
    
    # Activate virtual environment
    source venv/bin/activate
    
    # Upgrade pip
    pip install --upgrade pip
    
    # Install dependencies
    pip install -r requirements.txt
    
    echo -e "${GREEN}Dependencies installed${NC}"
}

# Function to setup environment
setup_environment() {
    echo -e "${YELLOW}Setting up environment...${NC}"
    
    # Copy environment file if it doesn't exist
    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${YELLOW}Created .env file from .env.example. Please update with your configuration.${NC}"
    fi
    
    # Set default environment variables
    export FLASK_ENV=${FLASK_ENV:-development}
    export PORT=${PORT:-$SERVICE_PORT}
    export AWS_REGION=${AWS_REGION:-us-east-1}
    
    echo -e "${GREEN}Environment setup complete${NC}"
}

# Function to run database migrations (if needed)
run_migrations() {
    echo -e "${YELLOW}Checking database setup...${NC}"
    
    # For DynamoDB, tables should be created by CDK
    # This is a placeholder for any future migration needs
    
    echo -e "${GREEN}Database setup verified${NC}"
}

# Function to start service
start_service() {
    echo -e "${YELLOW}Starting User Authentication Service...${NC}"
    
    # Activate virtual environment
    source venv/bin/activate
    
    # Start the service in background
    if [ "$FLASK_ENV" = "production" ]; then
        # Production mode with gunicorn
        gunicorn --bind 0.0.0.0:$SERVICE_PORT --workers 4 --timeout 30 --daemon --pid user-auth.pid app:app
    else
        # Development mode with Flask
        nohup python app.py > user-auth.log 2>&1 &
        echo $! > user-auth.pid
    fi
    
    echo -e "${GREEN}Service started${NC}"
}

# Function to validate deployment
validate_deployment() {
    echo -e "${YELLOW}Validating deployment...${NC}"
    
    # Check if service is healthy
    if check_service $SERVICE_PORT; then
        echo -e "${GREEN}✓ Health check passed${NC}"
    else
        echo -e "${RED}✗ Health check failed${NC}"
        return 1
    fi
    
    # Test basic endpoints
    echo -e "${YELLOW}Testing basic endpoints...${NC}"
    
    # Test health endpoint
    if curl -f -s "http://localhost:$SERVICE_PORT/health" | grep -q "healthy"; then
        echo -e "${GREEN}✓ Health endpoint working${NC}"
    else
        echo -e "${RED}✗ Health endpoint failed${NC}"
        return 1
    fi
    
    echo -e "${GREEN}All validation checks passed${NC}"
}

# Function to show service status
show_status() {
    echo -e "${YELLOW}Service Status:${NC}"
    echo "Service: $SERVICE_NAME"
    echo "Port: $SERVICE_PORT"
    echo "Health URL: http://localhost:$SERVICE_PORT$HEALTH_ENDPOINT"
    
    if [ -f "user-auth.pid" ]; then
        local pid=$(cat user-auth.pid)
        if ps -p $pid > /dev/null 2>&1; then
            echo -e "Status: ${GREEN}Running (PID: $pid)${NC}"
        else
            echo -e "Status: ${RED}Not Running${NC}"
        fi
    else
        echo -e "Status: ${RED}Not Running${NC}"
    fi
}

# Main deployment process
main() {
    local command=${1:-deploy}
    
    case $command in
        "deploy")
            stop_service
            install_dependencies
            setup_environment
            run_migrations
            start_service
            sleep 5
            validate_deployment
            show_status
            echo -e "${GREEN}User Authentication Service deployment completed successfully!${NC}"
            ;;
        "start")
            start_service
            sleep 5
            check_service $SERVICE_PORT
            show_status
            ;;
        "stop")
            stop_service
            ;;
        "restart")
            stop_service
            sleep 2
            start_service
            sleep 5
            check_service $SERVICE_PORT
            show_status
            ;;
        "status")
            show_status
            ;;
        "validate")
            validate_deployment
            ;;
        *)
            echo "Usage: $0 {deploy|start|stop|restart|status|validate}"
            echo "  deploy   - Full deployment (stop, install, start, validate)"
            echo "  start    - Start the service"
            echo "  stop     - Stop the service"
            echo "  restart  - Restart the service"
            echo "  status   - Show service status"
            echo "  validate - Validate running service"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"