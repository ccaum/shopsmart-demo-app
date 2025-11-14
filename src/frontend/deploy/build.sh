#!/bin/bash

# Frontend Build Script
# This script prepares the frontend for deployment by updating configuration

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting frontend build process...${NC}"

# Check if config file exists
if [ ! -f "deploy/config.env" ]; then
    echo -e "${RED}Error: deploy/config.env not found${NC}"
    echo -e "${YELLOW}Please copy deploy/config.env.example to deploy/config.env and update with your values${NC}"
    exit 1
fi

# Load configuration
source deploy/config.env

# Create build directory
BUILD_DIR="build"
echo -e "${GREEN}Creating build directory: $BUILD_DIR${NC}"
rm -rf $BUILD_DIR
mkdir -p $BUILD_DIR

# Copy static files
echo -e "${GREEN}Copying static files...${NC}"
cp -r css js *.html $BUILD_DIR/

# Update configuration based on environment
echo -e "${GREEN}Updating API configuration for $ENVIRONMENT environment...${NC}"

# Create environment-specific config file
cat > $BUILD_DIR/js/config.production.js << EOF
// Production API Configuration - Generated during build
const API_CONFIG = {
    // Product Catalog Service (EC2)
    PRODUCT_SERVICE: {
        BASE_URL: '$PRODUCT_SERVICE_URL',
        ENDPOINTS: {
            PRODUCTS: '/products',
            PRODUCT_DETAIL: '/products/{id}',
            CATEGORIES: '/products/categories',
            AVAILABILITY: '/products/{id}/availability'
        }
    },
    
    // Authentication Service (Lambda via API Gateway)
    AUTH_SERVICE: {
        BASE_URL: '$AUTH_SERVICE_URL',
        ENDPOINTS: {
            LOGIN: '/auth/login',
            REGISTER: '/auth/register',
            VALIDATE: '/auth/validate/{sessionId}',
            CART: '/auth/cart/{userId}',
            CART_ITEMS: '/auth/cart/{userId}/items',
            CART_ITEM: '/auth/cart/{userId}/items/{itemId}',
            CLEAR_CART: '/auth/cart/{userId}'
        }
    },
    
    // Order Processing Service (ECS)
    ORDER_SERVICE: {
        BASE_URL: '$ORDER_SERVICE_URL',
        ENDPOINTS: {
            ORDERS: '/orders',
            ORDER_DETAIL: '/orders/{orderId}',
            USER_ORDERS: '/orders/{userId}',
            ORDER_STATUS: '/orders/{orderId}/status'
        }
    }
};

// Application Configuration
const APP_CONFIG = {
    PAGINATION: {
        DEFAULT_PAGE_SIZE: 12,
        MAX_PAGE_SIZE: 50
    },
    CACHE: {
        PRODUCTS_TTL: 5 * 60 * 1000, // 5 minutes
        CATEGORIES_TTL: 15 * 60 * 1000 // 15 minutes
    },
    UI: {
        SEARCH_DEBOUNCE_MS: 300,
        LOADING_TIMEOUT_MS: 10000
    }
};

// Environment Detection
const ENVIRONMENT = {
    isDevelopment: () => false,
    isProduction: () => true
};

// Utility function to build API URLs
function buildApiUrl(service, endpoint, params = {}) {
    let url = API_CONFIG[service].BASE_URL + API_CONFIG[service].ENDPOINTS[endpoint];
    
    // Replace path parameters
    Object.keys(params).forEach(key => {
        url = url.replace(\`{\${key}}\`, params[key]);
    });
    
    return url;
}

// Export for use in other modules
window.API_CONFIG = API_CONFIG;
window.APP_CONFIG = APP_CONFIG;
window.ENVIRONMENT = ENVIRONMENT;
window.buildApiUrl = buildApiUrl;
EOF

# Replace config.js with production version
mv $BUILD_DIR/js/config.production.js $BUILD_DIR/js/config.js

# Update HTML files to include CORS meta tags and security headers
echo -e "${GREEN}Adding security and CORS configuration to HTML files...${NC}"

for html_file in $BUILD_DIR/*.html; do
    # Add meta tags for security and CORS
    sed -i.bak '/<head>/a\
    <meta http-equiv="Content-Security-Policy" content="default-src '\''self'\''; script-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\''; img-src '\''self'\'' data: https:; connect-src '\''self'\'' '$AUTH_SERVICE_URL' '$PRODUCT_SERVICE_URL' '$ORDER_SERVICE_URL';">\
    <meta http-equiv="X-Content-Type-Options" content="nosniff">\
    <meta http-equiv="X-Frame-Options" content="DENY">\
    <meta http-equiv="X-XSS-Protection" content="1; mode=block">
    ' "$html_file"
    
    # Remove backup file
    rm "${html_file}.bak"
done

# Create deployment manifest
cat > $BUILD_DIR/deployment-manifest.json << EOF
{
    "buildTime": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "environment": "$ENVIRONMENT",
    "services": {
        "authService": "$AUTH_SERVICE_URL",
        "productService": "$PRODUCT_SERVICE_URL",
        "orderService": "$ORDER_SERVICE_URL"
    },
    "deploymentTarget": "$DEPLOYMENT_TARGET",
    "corsOrigins": "$CORS_ALLOWED_ORIGINS"
}
EOF

echo -e "${GREEN}Build completed successfully!${NC}"
echo -e "${YELLOW}Build artifacts are in the '$BUILD_DIR' directory${NC}"
echo -e "${YELLOW}Next step: Run deploy.sh to deploy to your target environment${NC}"