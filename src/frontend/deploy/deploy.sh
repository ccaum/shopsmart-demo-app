#!/bin/bash

# Frontend Deployment Script
# Deploys the built frontend to either S3 or EC2

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting frontend deployment...${NC}"

# Check if config file exists
if [ ! -f "deploy/config.env" ]; then
    echo -e "${RED}Error: deploy/config.env not found${NC}"
    echo -e "${YELLOW}Please copy deploy/config.env.example to deploy/config.env and update with your values${NC}"
    exit 1
fi

# Load configuration
source deploy/config.env

# Check if build directory exists
BUILD_DIR="build"
if [ ! -d "$BUILD_DIR" ]; then
    echo -e "${RED}Error: Build directory not found${NC}"
    echo -e "${YELLOW}Please run build.sh first${NC}"
    exit 1
fi

# Function to deploy to S3
deploy_to_s3() {
    echo -e "${BLUE}Deploying to S3 bucket: $S3_BUCKET_NAME${NC}"
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}Error: AWS CLI not found${NC}"
        echo -e "${YELLOW}Please install AWS CLI and configure credentials${NC}"
        exit 1
    fi
    
    # Sync files to S3
    echo -e "${GREEN}Syncing files to S3...${NC}"
    aws s3 sync $BUILD_DIR/ s3://$S3_BUCKET_NAME/ --delete
    
    # Set proper content types
    echo -e "${GREEN}Setting content types...${NC}"
    aws s3 cp s3://$S3_BUCKET_NAME/ s3://$S3_BUCKET_NAME/ --recursive \
        --metadata-directive REPLACE \
        --content-type "text/html" \
        --exclude "*" --include "*.html"
    
    aws s3 cp s3://$S3_BUCKET_NAME/ s3://$S3_BUCKET_NAME/ --recursive \
        --metadata-directive REPLACE \
        --content-type "text/css" \
        --exclude "*" --include "*.css"
    
    aws s3 cp s3://$S3_BUCKET_NAME/ s3://$S3_BUCKET_NAME/ --recursive \
        --metadata-directive REPLACE \
        --content-type "application/javascript" \
        --exclude "*" --include "*.js"
    
    # Invalidate CloudFront cache if distribution ID is provided
    if [ ! -z "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
        echo -e "${GREEN}Invalidating CloudFront cache...${NC}"
        aws cloudfront create-invalidation \
            --distribution-id $CLOUDFRONT_DISTRIBUTION_ID \
            --paths "/*"
    fi
    
    echo -e "${GREEN}S3 deployment completed successfully!${NC}"
}

# Function to deploy to EC2
deploy_to_ec2() {
    echo -e "${BLUE}Deploying to EC2 instance: $EC2_INSTANCE_IP${NC}"
    
    # Check if SSH key exists
    if [ ! -f "$EC2_KEY_PATH" ]; then
        echo -e "${RED}Error: SSH key not found at $EC2_KEY_PATH${NC}"
        exit 1
    fi
    
    # Create deployment package
    echo -e "${GREEN}Creating deployment package...${NC}"
    tar -czf frontend-deployment.tar.gz -C $BUILD_DIR .
    
    # Copy files to EC2
    echo -e "${GREEN}Copying files to EC2...${NC}"
    scp -i $EC2_KEY_PATH frontend-deployment.tar.gz $EC2_USER@$EC2_INSTANCE_IP:/tmp/
    
    # Deploy on EC2
    echo -e "${GREEN}Deploying on EC2...${NC}"
    ssh -i $EC2_KEY_PATH $EC2_USER@$EC2_INSTANCE_IP << 'EOF'
        # Create web directory if it doesn't exist
        sudo mkdir -p /var/www/html
        
        # Extract files
        cd /tmp
        sudo tar -xzf frontend-deployment.tar.gz -C /var/www/html/
        
        # Set proper permissions
        sudo chown -R www-data:www-data /var/www/html/
        sudo chmod -R 755 /var/www/html/
        
        # Restart nginx if it's running
        if systemctl is-active --quiet nginx; then
            sudo systemctl reload nginx
        fi
        
        # Clean up
        rm -f /tmp/frontend-deployment.tar.gz
EOF
    
    # Clean up local deployment package
    rm -f frontend-deployment.tar.gz
    
    echo -e "${GREEN}EC2 deployment completed successfully!${NC}"
}

# Deploy based on target
case $DEPLOYMENT_TARGET in
    "s3")
        deploy_to_s3
        ;;
    "ec2")
        deploy_to_ec2
        ;;
    *)
        echo -e "${RED}Error: Invalid deployment target '$DEPLOYMENT_TARGET'${NC}"
        echo -e "${YELLOW}Valid targets are: s3, ec2${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}Deployment completed successfully!${NC}"
echo -e "${YELLOW}Don't forget to update your DNS records if needed${NC}"