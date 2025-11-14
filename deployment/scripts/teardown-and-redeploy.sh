#!/bin/bash
set -e

# Complete ShopSmart Infrastructure Teardown and Redeploy Script
echo "🔥 Starting complete ShopSmart infrastructure teardown and redeploy..."

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CDK_DIR="$PROJECT_ROOT/deployment/cdk"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_section() {
    echo -e "${PURPLE}🔸 $1${NC}"
}

REGION="us-west-2"

# Function to terminate instances immediately before stack deletion
terminate_instances_immediately() {
    local stack_name=$1
    print_status "Terminating instances immediately for $stack_name..."
    
    # Get Auto Scaling Groups from the stack
    local asg_names=$(aws cloudformation describe-stack-resources \
        --stack-name "$stack_name" \
        --region $REGION \
        --query 'StackResources[?ResourceType==`AWS::AutoScaling::AutoScalingGroup`].PhysicalResourceId' \
        --output text 2>/dev/null || echo "")
    
    if [ ! -z "$asg_names" ]; then
        for asg_name in $asg_names; do
            print_status "Getting instances from ASG: $asg_name"
            local instance_ids=$(aws autoscaling describe-auto-scaling-groups \
                --auto-scaling-group-names "$asg_name" \
                --region $REGION \
                --query 'AutoScalingGroups[0].Instances[].InstanceId' \
                --output text 2>/dev/null || echo "")
            
            if [[ -n "$instance_ids" && "$instance_ids" != *None* ]]; then
                print_status "Terminating instances immediately: $instance_ids"
                aws ec2 terminate-instances --instance-ids $instance_ids --region $REGION
                print_success "Instances terminated: $instance_ids"
            fi
        done
    fi
    
    # Also get EC2 instances directly from the stack
    local ec2_instances=$(aws cloudformation describe-stack-resources \
        --stack-name "$stack_name" \
        --region $REGION \
        --query 'StackResources[?ResourceType==`AWS::EC2::Instance`].PhysicalResourceId' \
        --output text 2>/dev/null || echo "")
    
    if [ ! -z "$ec2_instances" ]; then
        print_status "Terminating EC2 instances immediately: $ec2_instances"
        aws ec2 terminate-instances --instance-ids $ec2_instances --region $REGION
        print_success "EC2 instances terminated: $ec2_instances"
    fi
}

# Function to wait for stack deletion
wait_for_stack_deletion() {
    local stack_name=$1
    print_status "Waiting for $stack_name to be deleted..."
    
    while true; do
        local status=$(aws cloudformation describe-stacks --stack-name "$stack_name" --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DELETE_COMPLETE")
        
        if [ "$status" = "DELETE_COMPLETE" ] || [ "$status" = "DELETE_COMPLETE" ]; then
            print_success "$stack_name deleted successfully"
            break
        elif [ "$status" = "DELETE_FAILED" ]; then
            print_error "$stack_name deletion failed"
            break
        else
            print_status "$stack_name status: $status - waiting..."
            sleep 30
        fi
    done
}

# Function to delete stack with retry
delete_stack_with_retry() {
    local stack_name=$1
    local max_retries=3
    local retry_count=0
    
    # First, terminate instances immediately
    terminate_instances_immediately "$stack_name"
    
    while [ $retry_count -lt $max_retries ]; do
        print_status "Attempting to delete $stack_name (attempt $((retry_count + 1))/$max_retries)"
        
        if aws cloudformation delete-stack --stack-name "$stack_name" --region $REGION 2>/dev/null; then
            wait_for_stack_deletion "$stack_name"
            return 0
        else
            retry_count=$((retry_count + 1))
            if [ $retry_count -lt $max_retries ]; then
                print_warning "Deletion attempt failed, retrying in 30 seconds..."
                sleep 30
            else
                print_error "Failed to delete $stack_name after $max_retries attempts"
                return 1
            fi
        fi
    done
}

# ============================================================================
# PHASE 1: TEARDOWN EXISTING INFRASTRUCTURE
# ============================================================================

print_section "PHASE 1: TEARING DOWN EXISTING INFRASTRUCTURE"

# Get list of all ShopSmart stacks
STACKS=$(aws cloudformation list-stacks --region $REGION --query 'StackSummaries[?contains(StackName, `ShopSmart`) && StackStatus != `DELETE_COMPLETE`].StackName' --output text)

if [ -z "$STACKS" ]; then
    print_success "No ShopSmart stacks found to delete"
else
    print_status "Found ShopSmart stacks to delete: $STACKS"
    
    # Delete stacks in reverse dependency order (reverse of deploy order)
    STACK_ORDER=(
        "ShopSmart-Frontend-v2"
        "ShopSmart-ApiGatewayRouter-v2"
        "ShopSmart-ServiceIntegration-v2"
        "ShopSmart-OrderProcessing-v2"
        "ShopSmart-ProductCatalog-v2"
        "ShopSmart-UserAuth-v2"
        "ShopSmart-OtelCollector-v2"
        "ShopSmart-Monitoring-v2"
        "ShopSmart-SharedInfra-v2"
    )
    
    for stack in "${STACK_ORDER[@]}"; do
        # Check if stack exists
        if echo "$STACKS" | grep -q "$stack"; then
            print_status "Deleting $stack..."
            delete_stack_with_retry "$stack"
        else
            print_status "$stack not found, skipping..."
        fi
    done
fi

# Clean up any remaining nested stacks or resources
print_status "Cleaning up any remaining nested stacks..."
NESTED_STACKS=$(aws cloudformation list-stacks --region $REGION --query 'StackSummaries[?contains(StackName, `KubectlProvider`) || contains(StackName, `AwsAuth`) || contains(StackName, `NodeGroup`)].StackName' --output text)

if [ ! -z "$NESTED_STACKS" ]; then
    for nested_stack in $NESTED_STACKS; do
        print_status "Deleting nested stack: $nested_stack"
        delete_stack_with_retry "$nested_stack"
    done
fi

# ============================================================================
# PHASE 2: CLEAN UP CDK CONTEXT AND CACHE
# ============================================================================

print_section "PHASE 2: CLEANING UP CDK CONTEXT AND CACHE"

cd "$CDK_DIR"

print_status "Clearing CDK context..."
if [ -f "cdk.context.json" ]; then
    rm -f cdk.context.json
    print_success "Removed cdk.context.json"
fi

print_status "Clearing CDK output directories..."
rm -rf cdk.out cdk-deploy.out
print_success "Cleared CDK output directories"

# ============================================================================
# PHASE 3: PREPARE FOR REDEPLOYMENT
# ============================================================================

print_section "PHASE 3: PREPARING FOR REDEPLOYMENT"

# Check if we're in the right directory
if [ ! -f "$CDK_DIR/package.json" ]; then
    print_error "CDK package.json not found at $CDK_DIR/package.json"
    exit 1
fi

# Update dependencies
print_status "Updating npm dependencies..."
npm install

# Build the project
print_status "Building TypeScript project..."
npm run build

if [ $? -ne 0 ]; then
    print_error "Build failed. Please fix TypeScript errors and try again."
    exit 1
fi

print_success "Build completed successfully"

# Bootstrap CDK (in case it's needed)
print_status "Bootstrapping CDK environment..."
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$REGION

# ============================================================================
# PHASE 4: REDEPLOY INFRASTRUCTURE
# ============================================================================

print_section "PHASE 4: REDEPLOYING INFRASTRUCTURE"

print_status "Calling deploy-shopsmart.sh for fresh deployment..."

# Call the deploy script
if [ -f "$SCRIPT_DIR/deploy-shopsmart.sh" ]; then
    chmod +x "$SCRIPT_DIR/deploy-shopsmart.sh"
    "$SCRIPT_DIR/deploy-shopsmart.sh"
else
    print_error "deploy-shopsmart.sh not found at $SCRIPT_DIR/deploy-shopsmart.sh"
    exit 1
fi

# ============================================================================
# COMPLETION
# ============================================================================

print_section "TEARDOWN AND REDEPLOY COMPLETED!"

print_success "ShopSmart infrastructure has been completely torn down and redeployed"

echo ""
echo "📋 Summary:"
echo "  ✅ All existing stacks deleted"
echo "  ✅ CDK context and cache cleared"
echo "  ✅ Fresh infrastructure deployed via deploy-shopsmart.sh"
echo ""
echo "🎉 Your ShopSmart infrastructure is ready!"
