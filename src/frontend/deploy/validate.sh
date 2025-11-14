#!/bin/bash

# Frontend Deployment Validation Script
# Validates that the deployment was successful and services are accessible

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting deployment validation...${NC}"

# Check if config file exists
if [ ! -f "deploy/config.env" ]; then
    echo -e "${RED}Error: deploy/config.env not found${NC}"
    exit 1
fi

# Load configuration
source deploy/config.env

# Function to test URL accessibility
test_url() {
    local url=$1
    local name=$2
    
    echo -e "${BLUE}Testing $name: $url${NC}"
    
    if curl -s --head --request GET "$url" | grep "200 OK" > /dev/null; then
        echo -e "${GREEN}✓ $name is accessible${NC}"
        return 0
    else
        echo -e "${RED}✗ $name is not accessible${NC}"
        return 1
    fi
}

# Function to test CORS
test_cors() {
    local url=$1
    local name=$2
    
    echo -e "${BLUE}Testing CORS for $name: $url${NC}"
    
    local cors_response=$(curl -s -H "Origin: https://example.com" \
                              -H "Access-Control-Request-Method: GET" \
                              -H "Access-Control-Request-Headers: Content-Type" \
                              -X OPTIONS "$url" \
                              -w "%{http_code}" -o /dev/null)
    
    if [ "$cors_response" = "200" ] || [ "$cors_response" = "204" ]; then
        echo -e "${GREEN}✓ CORS is configured for $name${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠ CORS may not be configured for $name (HTTP $cors_response)${NC}"
        return 1
    fi
}

# Determine frontend URL based on deployment target
if [ "$DEPLOYMENT_TARGET" = "s3" ]; then
    if [ ! -z "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
        # Get CloudFront domain name
        FRONTEND_URL=$(aws cloudfront get-distribution --id $CLOUDFRONT_DISTRIBUTION_ID --query 'Distribution.DomainName' --output text)
        FRONTEND_URL="https://$FRONTEND_URL"
    else
        FRONTEND_URL="http://$S3_BUCKET_NAME.s3-website-us-east-1.amazonaws.com"
    fi
elif [ "$DEPLOYMENT_TARGET" = "ec2" ]; then
    FRONTEND_URL="http://$EC2_INSTANCE_IP"
else
    echo -e "${RED}Unknown deployment target: $DEPLOYMENT_TARGET${NC}"
    exit 1
fi

echo -e "${BLUE}Frontend URL: $FRONTEND_URL${NC}"

# Test frontend accessibility
echo -e "\n${YELLOW}=== Testing Frontend Accessibility ===${NC}"
test_url "$FRONTEND_URL" "Frontend"
test_url "$FRONTEND_URL/health.html" "Health Check Page"

# Test API services
echo -e "\n${YELLOW}=== Testing API Services ===${NC}"
test_url "$PRODUCT_SERVICE_URL/health" "Product Service"
test_url "$ORDER_SERVICE_URL/health" "Order Service"
test_url "$AUTH_SERVICE_URL/health" "Auth Service"

# Test CORS configuration
echo -e "\n${YELLOW}=== Testing CORS Configuration ===${NC}"
test_cors "$PRODUCT_SERVICE_URL/products" "Product Service"
test_cors "$ORDER_SERVICE_URL/orders" "Order Service"
test_cors "$AUTH_SERVICE_URL/auth/login" "Auth Service"

# Test deployment manifest
echo -e "\n${YELLOW}=== Testing Deployment Manifest ===${NC}"
if curl -s "$FRONTEND_URL/deployment-manifest.json" | jq . > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Deployment manifest is valid JSON${NC}"
    
    # Show manifest content
    echo -e "${BLUE}Deployment manifest content:${NC}"
    curl -s "$FRONTEND_URL/deployment-manifest.json" | jq .
else
    echo -e "${RED}✗ Deployment manifest is not accessible or invalid${NC}"
fi

# Test static assets
echo -e "\n${YELLOW}=== Testing Static Assets ===${NC}"
test_url "$FRONTEND_URL/css/styles.css" "CSS File"
test_url "$FRONTEND_URL/js/config.js" "Config JS File"
test_url "$FRONTEND_URL/js/app.js" "App JS File"

# Performance test (basic)
echo -e "\n${YELLOW}=== Basic Performance Test ===${NC}"
echo -e "${BLUE}Testing page load time...${NC}"
load_time=$(curl -o /dev/null -s -w "%{time_total}" "$FRONTEND_URL")
echo -e "${GREEN}Page load time: ${load_time}s${NC}"

if (( $(echo "$load_time < 2.0" | bc -l) )); then
    echo -e "${GREEN}✓ Good performance (< 2s)${NC}"
elif (( $(echo "$load_time < 5.0" | bc -l) )); then
    echo -e "${YELLOW}⚠ Acceptable performance (< 5s)${NC}"
else
    echo -e "${RED}✗ Poor performance (> 5s)${NC}"
fi

echo -e "\n${GREEN}Deployment validation completed!${NC}"
echo -e "${YELLOW}Frontend is accessible at: $FRONTEND_URL${NC}"