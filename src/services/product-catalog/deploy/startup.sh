#!/bin/bash

# Product Catalog Service Startup Script
# This script is executed during EC2 instance startup via user data

set -e

# Configuration
SERVICE_NAME="product-catalog"
SERVICE_DIR="/opt/product-catalog"
LOG_FILE="/var/log/product-catalog-startup.log"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log "Starting Product Catalog Service startup script..."

# Wait for network connectivity
log "Waiting for network connectivity..."
while ! ping -c 1 google.com &> /dev/null; do
    sleep 5
done

# Get instance metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
AZ=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)

log "Instance ID: $INSTANCE_ID, Region: $REGION, AZ: $AZ"

# Download application code from S3 (if configured)
if [ ! -z "$APP_S3_BUCKET" ] && [ ! -z "$APP_S3_KEY" ]; then
    log "Downloading application code from S3..."
    aws s3 cp "s3://$APP_S3_BUCKET/$APP_S3_KEY" /tmp/product-catalog.tar.gz
    cd /tmp
    tar -xzf product-catalog.tar.gz
    
    # Run installation script
    if [ -f "/tmp/product-catalog/deploy/install.sh" ]; then
        log "Running installation script..."
        chmod +x /tmp/product-catalog/deploy/install.sh
        /tmp/product-catalog/deploy/install.sh
    fi
fi

# Load environment variables from AWS Systems Manager Parameter Store
log "Loading configuration from Parameter Store..."
if command -v aws &> /dev/null; then
    # Database configuration
    if aws ssm get-parameter --name "/shopsmart/product-catalog/database-host" --region "$REGION" &> /dev/null; then
        export DATABASE_HOST=$(aws ssm get-parameter --name "/shopsmart/product-catalog/database-host" --query 'Parameter.Value' --output text --region "$REGION")
    fi
    
    if aws ssm get-parameter --name "/shopsmart/product-catalog/redis-host" --region "$REGION" &> /dev/null; then
        export REDIS_HOST=$(aws ssm get-parameter --name "/shopsmart/product-catalog/redis-host" --query 'Parameter.Value' --output text --region "$REGION")
    fi
    
    # Create environment file
    cat > "$SERVICE_DIR/.env" <<EOF
DATABASE_HOST=${DATABASE_HOST:-localhost}
REDIS_HOST=${REDIS_HOST:-localhost}
AWS_REGION=${REGION}
SECRETS_MANAGER_DB_SECRET=${DB_SECRET_NAME}
CLOUDWATCH_ENABLED=true
DEBUG=false
EOF
    
    chown catalog:catalog "$SERVICE_DIR/.env"
    log "Environment configuration created"
fi

# Health check function
health_check() {
    local max_attempts=30
    local attempt=1
    
    log "Starting health check..."
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f -s http://localhost/health > /dev/null; then
            log "Health check passed on attempt $attempt"
            return 0
        fi
        
        log "Health check failed, attempt $attempt/$max_attempts"
        sleep 10
        ((attempt++))
    done
    
    log "Health check failed after $max_attempts attempts"
    return 1
}

# Start the service
log "Starting Product Catalog Service..."
systemctl start "$SERVICE_NAME"

# Wait for service to be ready
sleep 10

# Perform health check
if health_check; then
    log "Service started successfully and is healthy"
    
    # Send success metric to CloudWatch
    aws cloudwatch put-metric-data \
        --namespace "ShopSmart/ProductCatalog/Deployment" \
        --metric-data MetricName=StartupSuccess,Value=1,Unit=Count \
        --region "$REGION" || true
else
    log "Service failed health check"
    
    # Send failure metric to CloudWatch
    aws cloudwatch put-metric-data \
        --namespace "ShopSmart/ProductCatalog/Deployment" \
        --metric-data MetricName=StartupFailure,Value=1,Unit=Count \
        --region "$REGION" || true
    
    # Get service logs for debugging
    log "Service logs:"
    journalctl -u "$SERVICE_NAME" --no-pager -n 50 | tee -a "$LOG_FILE"
    
    exit 1
fi

# Register instance with load balancer (if using target group)
if [ ! -z "$TARGET_GROUP_ARN" ]; then
    log "Registering instance with target group..."
    aws elbv2 register-targets \
        --target-group-arn "$TARGET_GROUP_ARN" \
        --targets Id="$INSTANCE_ID" \
        --region "$REGION" || log "Failed to register with target group"
fi

log "Startup script completed successfully"