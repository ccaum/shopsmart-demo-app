#!/bin/bash

# ShopSmart Complete Deployment Script
# Deploys the entire ShopSmart e-commerce platform

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CDK_DIR="$PROJECT_ROOT/deployment/cdk"
REGION="${AWS_REGION:-us-west-2}"
ENVIRONMENT="prod"
ALERT_EMAIL="${ALERT_EMAIL:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
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

log_step() {
    echo -e "${BLUE}🔸 $1${NC}"
}

# Function to check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."
    
    # Check if we're in the right directory
    if [ ! -f "$CDK_DIR/package.json" ]; then
        log_error "CDK package.json not found at $CDK_DIR/package.json"
        exit 1
    fi
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        exit 1
    fi
    
    # Check CDK
    if ! command -v cdk &> /dev/null; then
        log_error "AWS CDK is not installed"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity > /dev/null 2>&1; then
        log_error "AWS CLI is not configured"
        exit 1
    fi
    
    log_success "Prerequisites check completed"
}

# Function to build CDK project
build_project() {
    log_step "Building CDK project..."
    
    cd "$CDK_DIR"
    
    # Install dependencies
    log_info "Installing npm dependencies..."
    npm install
    
    # Build TypeScript
    log_info "Building TypeScript..."
    npm run build
    
    log_success "Project build completed"
}

# Function to bootstrap CDK
bootstrap_cdk() {
    log_step "Bootstrapping CDK..."
    
    cd "$CDK_DIR"
    
    # Check if already bootstrapped
    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" > /dev/null 2>&1; then
        log_info "CDK already bootstrapped"
    else
        log_info "Bootstrapping CDK..."
        cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$REGION"
        log_success "CDK bootstrap completed"
    fi
}

# Function to deploy infrastructure stacks
deploy_infrastructure() {
    log_step "Deploying infrastructure stacks..."
    
    cd "$CDK_DIR"
    
    # Stack deployment order (respects dependencies)
    local stacks=(
        "ShopSmart-SharedInfra-v2"
        "ShopSmart-Monitoring-v2"
        "ShopSmart-OtelCollector-v2"
        "ShopSmart-UserAuth-v2"
        "ShopSmart-ProductCatalog-v2"
        "ShopSmart-OrderProcessing-v2"
        "ShopSmart-ServiceIntegration-v2"
        "ShopSmart-ApiGatewayRouter-v2"
        "ShopSmart-Frontend-v2"
    )
    
    for stack in "${stacks[@]}"; do
        log_info "Deploying $stack..."
        if cdk deploy "$stack" --require-approval never --no-rollback; then
            log_success "$stack deployed successfully"
        else
            log_error "$stack deployment failed"
            exit 1
        fi
        
        # Small delay between deployments
        sleep 5
    done
    
    log_success "Infrastructure deployment completed"
}

# Function to deploy monitoring
deploy_monitoring() {
    log_step "Deploying monitoring stack..."
    
    cd "$CDK_DIR"
    
    local cdk_context=""
    if [ -n "$ALERT_EMAIL" ]; then
        cdk_context="--context alertEmail=$ALERT_EMAIL"
        log_info "Using alert email: $ALERT_EMAIL"
    else
        log_warning "No ALERT_EMAIL set, email alerts will not be configured"
    fi
    
    if cdk deploy ShopSmart-Monitoring-v2 $cdk_context --require-approval never --no-rollback; then
        log_success "Monitoring stack deployed successfully"
    else
        log_warning "Monitoring stack deployment failed, continuing..."
    fi
}

# Function to initialize databases
initialize_databases() {
    log_step "Initializing databases..."
    
    if [ -f "$PROJECT_ROOT/src/database/init-databases.sh" ]; then
        log_info "Running database initialization..."
        chmod +x "$PROJECT_ROOT/src/database/init-databases.sh"
        cd "$PROJECT_ROOT/src/database"
        ./init-databases.sh || log_warning "Database initialization had issues"
        cd "$PROJECT_ROOT"
    else
        log_warning "Database initialization script not found"
    fi
}

# Function to deploy services
deploy_services() {
    log_step "Deploying application services..."
    
    # Deploy Product Catalog service
    if [ -f "$PROJECT_ROOT/src/services/product-catalog/deploy/deploy.sh" ]; then
        log_info "Deploying Product Catalog service..."
        chmod +x "$PROJECT_ROOT/src/services/product-catalog/deploy/deploy.sh"
        cd "$PROJECT_ROOT/src/services/product-catalog/deploy"
        ./deploy.sh || log_warning "Product Catalog deployment had issues"
        cd "$PROJECT_ROOT"
    fi
    
    # Deploy Auth service
    if [ -f "$PROJECT_ROOT/src/services/auth/deploy/deploy.sh" ]; then
        log_info "Deploying Auth service..."
        chmod +x "$PROJECT_ROOT/src/services/auth/deploy/deploy.sh"
        cd "$PROJECT_ROOT/src/services/auth/deploy"
        ./deploy.sh || log_warning "Auth service deployment had issues"
        cd "$PROJECT_ROOT"
    fi
}

# Function to deploy frontend
deploy_frontend() {
    log_step "Deploying frontend application..."
    
    if [ -f "$SCRIPT_DIR/deploy-frontend.sh" ]; then
        log_info "Running frontend deployment..."
        chmod +x "$SCRIPT_DIR/deploy-frontend.sh"
        "$SCRIPT_DIR/deploy-frontend.sh" || log_warning "Frontend deployment had issues"
    else
        log_warning "Frontend deployment script not found"
    fi
}

# Function to generate outputs
generate_outputs() {
    log_step "Generating deployment outputs..."
    
    cd "$PROJECT_ROOT"
    
    # Generate outputs file using list-exports (faster, no redeployment)
    log_info "Collecting stack outputs..."
    
    # Use timeout to prevent hanging
    timeout 60 aws cloudformation list-exports --region us-west-2 --query 'Exports[?contains(Name, `ShopSmart`)].{Name:Name,Value:Value}' --output json > stack-exports.json 2>/dev/null || true
    
    # Also try CDK outputs with timeout and specific stacks only
    timeout 120 cdk list --long 2>/dev/null | grep -E "ShopSmart-(SharedInfra|ProductCatalog|UserAuth|OrderProcessing|ServiceIntegration)-v2" | while read stack_line; do
        stack_name=$(echo "$stack_line" | awk '{print $1}')
        log_info "Getting outputs for $stack_name..."
        timeout 30 aws cloudformation describe-stacks --stack-name "$stack_name" --region us-west-2 --query 'Stacks[0].Outputs' --output json > "${stack_name}-outputs.json" 2>/dev/null || true
    done
    
    if [ -f "stack-exports.json" ] || ls *-outputs.json >/dev/null 2>&1; then
        log_success "Stack outputs collected successfully"
        log_info "Files created: stack-exports.json and individual stack output files"
    else
        log_warning "Failed to collect stack outputs (non-critical)"
    fi

}

# Function to run validation
run_validation() {
    log_step "Running system validation..."
    
    if [ -f "$SCRIPT_DIR/validate-system.sh" ]; then
        log_info "Running end-to-end validation (with 5 minute timeout)..."
        chmod +x "$SCRIPT_DIR/validate-system.sh"
        
        # Run validation with timeout to prevent hanging (macOS compatible)
        if command -v timeout >/dev/null 2>&1; then
            timeout 300 "$SCRIPT_DIR/validate-system.sh" || {
                exit_code=$?
                if [ $exit_code -eq 124 ]; then
                    log_warning "Validation timed out after 5 minutes"
                else
                    log_warning "Some validation tests failed (exit code: $exit_code)"
                fi
            }
        elif command -v gtimeout >/dev/null 2>&1; then
            gtimeout 300 "$SCRIPT_DIR/validate-system.sh" || {
                exit_code=$?
                if [ $exit_code -eq 124 ]; then
                    log_warning "Validation timed out after 5 minutes"
                else
                    log_warning "Some validation tests failed (exit code: $exit_code)"
                fi
            }
        else
            # Fallback without timeout on macOS
            "$SCRIPT_DIR/validate-system.sh" || {
                exit_code=$?
                log_warning "Some validation tests failed (exit code: $exit_code)"
            }
        fi
    else
        log_warning "Validation script not found"
    fi
}

# Function to display deployment summary
show_deployment_summary() {
    log_step "Deployment Summary"
    
    echo ""
    echo "=========================================="
    echo "🎉 ShopSmart Deployment Completed!"
    echo "=========================================="
    echo ""
    echo "📊 Deployment Details:"
    echo "   Environment: $ENVIRONMENT"
    echo "   Region: $REGION"
    echo "   Timestamp: $(date)"
    echo ""
    
    # Show key endpoints
    if [ -f "$PROJECT_ROOT/outputs.json" ]; then
        echo "🔗 Service Endpoints:"
        
        if command -v jq &> /dev/null; then
            local alb_url=$(jq -r '.["ShopSmart-ProductCatalog"].ProductCatalogALBDnsName // "Not available"' "$PROJECT_ROOT/outputs.json")
            local api_url=$(jq -r '.["ShopSmart-UserAuth"].UserAuthApiGatewayUrl // "Not available"' "$PROJECT_ROOT/outputs.json")
            
            echo "   Frontend: http://$alb_url"
            echo "   Product Catalog: http://$alb_url"
            echo "   User Auth API: $api_url"
        else
            echo "   Check outputs.json for service endpoints"
        fi
        echo ""
    fi
    
    echo "✅ Deployed Components:"
    echo "   • Shared Infrastructure (VPC, Networking)"
    echo "   • Monitoring & Observability (CloudWatch, Dynatrace)"
    echo "   • OpenTelemetry Collector (Logs, Traces, Metrics)"
    echo "   • Product Catalog Service (EC2, RDS, ElastiCache)"
    echo "   • User Authentication Service (Lambda, API Gateway, DynamoDB)"
    echo "   • Order Processing Service (ECS, MongoDB)"
    echo "   • Service Integration (EventBridge, SNS)"
    echo "   • API Gateway Router (ALB, Lambda)"
    echo "   • Frontend Application (CloudFront, S3)"
    echo ""
    
    # Get CloudFront URL
    local cloudfront_url=$(aws cloudformation describe-stacks --stack-name ShopSmart-Frontend-v2 --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontURL`].OutputValue' --output text 2>/dev/null || echo "")
    
    if [ -n "$cloudfront_url" ]; then
        echo "🌐 Frontend URL:"
        echo "   $cloudfront_url"
        echo ""
        echo "   👉 Click here to visit the ShopSmart website!"
    else
        echo "🌐 Frontend URL: Check CloudFormation outputs for ShopSmart-Frontend stack"
    fi
    echo ""
    
    echo "🔧 Next Steps:"
    echo "   1. Visit the frontend at the CloudFront URL above"
    echo "   2. Test with demo credentials: demo@artisandesks.com / demo"
    echo "   3. Monitor via CloudWatch dashboards"
    echo "   4. View logs and traces in Dynatrace"
    echo ""
    
    echo "🗑️  To tear down and redeploy:"
    echo "   ./deployment/scripts/teardown-redeploy-shopsmart.sh"
}

# Main execution function
main() {
    echo "🚀 ShopSmart Complete Deployment"
    echo "================================="
    echo ""
    
    # Set error handling
    trap 'log_error "Deployment failed!"; exit 1' ERR
    
    # Execute deployment steps
    check_prerequisites
    build_project
    bootstrap_cdk
    deploy_infrastructure
    deploy_monitoring
    initialize_databases
    deploy_services
    deploy_frontend
    generate_outputs
    run_validation
    show_deployment_summary
    
    log_success "ShopSmart deployment completed successfully! 🎉"
}

# Show usage if help requested
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "Usage: $0"
    echo ""
    echo "Environment Variables:"
    echo "  AWS_REGION     AWS region (default: us-west-2)"
    echo "  ENVIRONMENT    Environment name (default: prod)"
    echo "  ALERT_EMAIL    Email for monitoring alerts (optional)"
    echo ""
    echo "Example:"
    echo "  export AWS_REGION=us-west-2"
    echo "  export ENVIRONMENT=prod"
    echo "  export ALERT_EMAIL=admin@company.com"
    echo "  $0"
    exit 0
fi

# Execute main function
main "$@"
