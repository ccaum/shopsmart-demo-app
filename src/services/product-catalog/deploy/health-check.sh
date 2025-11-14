#!/bin/bash

# Product Catalog Service Health Check Script
# Used by load balancer and monitoring systems

set -e

# Configuration
SERVICE_NAME="product-catalog"
HEALTH_ENDPOINT="http://localhost/health"
TIMEOUT=10

# Health check function
perform_health_check() {
    local response
    local http_code
    
    # Make HTTP request to health endpoint
    response=$(curl -s -w "HTTPSTATUS:%{http_code}" --max-time "$TIMEOUT" "$HEALTH_ENDPOINT" 2>/dev/null)
    
    # Extract HTTP status code
    http_code=$(echo "$response" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    
    # Extract response body
    body=$(echo "$response" | sed -e 's/HTTPSTATUS\:.*//g')
    
    # Check if HTTP status is 200
    if [ "$http_code" -eq 200 ]; then
        # Parse JSON response to check status
        if echo "$body" | grep -q '"status":"healthy"'; then
            echo "HEALTHY: Service is responding correctly"
            return 0
        else
            echo "UNHEALTHY: Service responded but status is not healthy"
            echo "Response: $body"
            return 1
        fi
    else
        echo "UNHEALTHY: HTTP status code $http_code"
        echo "Response: $body"
        return 1
    fi
}

# Check if service is running
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "UNHEALTHY: Service $SERVICE_NAME is not running"
    exit 1
fi

# Perform health check
if perform_health_check; then
    exit 0
else
    exit 1
fi