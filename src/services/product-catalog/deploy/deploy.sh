#!/bin/bash

# Product Catalog Service Deployment Script
# Deploys the service to EC2 instances via Auto Scaling Group

set -e

# Configuration
SERVICE_NAME="product-catalog"
S3_BUCKET="${DEPLOYMENT_S3_BUCKET:-shopsmart-deployments}"
S3_KEY="product-catalog/$(date +%Y%m%d-%H%M%S)/product-catalog.tar.gz"
ASG_NAME="${ASG_NAME:-ShopSmart-ProductCatalog-ASG}"
REGION="${AWS_REGION:-us-east-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    if ! command -v aws &> /dev/null; then
        error "AWS CLI is not installed"
        exit 1
    fi
    
    if ! command -v tar &> /dev/null; then
        error "tar is not installed"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured"
        exit 1
    fi
    
    log "Prerequisites check passed"
}

# Package application
package_application() {
    log "Packaging application..."
    
    local temp_dir=$(mktemp -d)
    local package_dir="$temp_dir/product-catalog"
    
    # Create package directory structure
    mkdir -p "$package_dir"
    
    # Copy application files
    cp -r *.py requirements.txt "$package_dir/"
    cp -r services/ "$package_dir/"
    cp -r middleware/ "$package_dir/"
    cp -r models.py "$package_dir/"
    cp -r deploy/ "$package_dir/"
    
    # Create .env.example if it doesn't exist
    if [ ! -f "$package_dir/.env.example" ]; then
        cp .env.example "$package_dir/" 2>/dev/null || true
    fi
    
    # Create tarball
    cd "$temp_dir"
    tar -czf product-catalog.tar.gz product-catalog/
    
    # Upload to S3
    log "Uploading package to S3..."
    aws s3 cp product-catalog.tar.gz "s3://$S3_BUCKET/$S3_KEY" --region "$REGION"
    
    # Cleanup
    rm -rf "$temp_dir"
    
    log "Package uploaded to s3://$S3_BUCKET/$S3_KEY"
}

# Update launch template
update_launch_template() {
    log "Updating launch template..."
    
    # Get current launch template
    local lt_id=$(aws autoscaling describe-auto-scaling-groups \
        --auto-scaling-group-names "$ASG_NAME" \
        --query 'AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId' \
        --output text --region "$REGION")
    
    if [ "$lt_id" = "None" ] || [ -z "$lt_id" ]; then
        warn "No launch template found for ASG $ASG_NAME"
        return 1
    fi
    
    # Create user data script
    local user_data=$(cat <<EOF | base64 -w 0
#!/bin/bash
export APP_S3_BUCKET="$S3_BUCKET"
export APP_S3_KEY="$S3_KEY"
export AWS_REGION="$REGION"

# Download and execute startup script
aws s3 cp "s3://$S3_BUCKET/$S3_KEY" /tmp/product-catalog.tar.gz --region "$REGION"
cd /tmp
tar -xzf product-catalog.tar.gz
chmod +x product-catalog/deploy/startup.sh
./product-catalog/deploy/startup.sh
EOF
)
    
    # Create new launch template version
    local new_version=$(aws ec2 create-launch-template-version \
        --launch-template-id "$lt_id" \
        --source-version '$Latest' \
        --launch-template-data "{\"UserData\":\"$user_data\"}" \
        --query 'LaunchTemplateVersion.VersionNumber' \
        --output text --region "$REGION")
    
    log "Created launch template version $new_version"
    
    # Update ASG to use new version
    aws autoscaling update-auto-scaling-group \
        --auto-scaling-group-name "$ASG_NAME" \
        --launch-template LaunchTemplateId="$lt_id",Version="$new_version" \
        --region "$REGION"
    
    log "Updated ASG to use launch template version $new_version"
}

# Perform rolling deployment
rolling_deployment() {
    log "Starting rolling deployment..."
    
    # Get current ASG configuration
    local asg_info=$(aws autoscaling describe-auto-scaling-groups \
        --auto-scaling-group-names "$ASG_NAME" \
        --region "$REGION")
    
    local desired_capacity=$(echo "$asg_info" | jq -r '.AutoScalingGroups[0].DesiredCapacity')
    local min_size=$(echo "$asg_info" | jq -r '.AutoScalingGroups[0].MinSize')
    local max_size=$(echo "$asg_info" | jq -r '.AutoScalingGroups[0].MaxSize')
    
    log "Current ASG configuration: Min=$min_size, Desired=$desired_capacity, Max=$max_size"
    
    # Temporarily increase max size to allow for rolling deployment
    local temp_max_size=$((max_size + desired_capacity))
    
    aws autoscaling update-auto-scaling-group \
        --auto-scaling-group-name "$ASG_NAME" \
        --max-size "$temp_max_size" \
        --region "$REGION"
    
    log "Temporarily increased max size to $temp_max_size"
    
    # Start instance refresh
    local refresh_id=$(aws autoscaling start-instance-refresh \
        --auto-scaling-group-name "$ASG_NAME" \
        --preferences MinHealthyPercentage=50,InstanceWarmup=300 \
        --query 'InstanceRefreshId' \
        --output text --region "$REGION")
    
    log "Started instance refresh: $refresh_id"
    
    # Wait for instance refresh to complete
    log "Waiting for instance refresh to complete..."
    while true; do
        local status=$(aws autoscaling describe-instance-refreshes \
            --auto-scaling-group-name "$ASG_NAME" \
            --instance-refresh-ids "$refresh_id" \
            --query 'InstanceRefreshes[0].Status' \
            --output text --region "$REGION")
        
        case "$status" in
            "Successful")
                log "Instance refresh completed successfully"
                break
                ;;
            "Failed"|"Cancelled")
                error "Instance refresh failed with status: $status"
                exit 1
                ;;
            *)
                log "Instance refresh status: $status"
                sleep 30
                ;;
        esac
    done
    
    # Restore original max size
    aws autoscaling update-auto-scaling-group \
        --auto-scaling-group-name "$ASG_NAME" \
        --max-size "$max_size" \
        --region "$REGION"
    
    log "Restored max size to $max_size"
}

# Verify deployment
verify_deployment() {
    log "Verifying deployment..."
    
    # Get ALB target group ARN
    local tg_arn=$(aws elbv2 describe-target-groups \
        --names "ShopSmart-ProductCatalog-TG" \
        --query 'TargetGroups[0].TargetGroupArn' \
        --output text --region "$REGION" 2>/dev/null || echo "")
    
    if [ -n "$tg_arn" ] && [ "$tg_arn" != "None" ]; then
        # Check target health
        local healthy_targets=$(aws elbv2 describe-target-health \
            --target-group-arn "$tg_arn" \
            --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`]' \
            --output json --region "$REGION" | jq length)
        
        log "Healthy targets: $healthy_targets"
        
        if [ "$healthy_targets" -gt 0 ]; then
            log "Deployment verification successful"
        else
            error "No healthy targets found"
            exit 1
        fi
    else
        warn "Could not find target group for verification"
    fi
}

# Main deployment process
main() {
    log "Starting Product Catalog Service deployment..."
    
    check_prerequisites
    package_application
    update_launch_template
    rolling_deployment
    verify_deployment
    
    log "Deployment completed successfully!"
}

# Run main function
main "$@"