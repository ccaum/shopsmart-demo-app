#!/bin/bash

# ShopSmart Environment Deployment Script
# Usage: ./scripts/deploy-environment.sh <environment> [stack-name]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CDK_DIR="$PROJECT_ROOT/deployment/cdk"
ENVIRONMENT=${1:-prod}
SPECIFIC_STACK=${2:-""}
AWS_REGION=${AWS_REGION:-us-west-2}

# Validate environment
case $ENVIRONMENT in
  dev|development)
    ENV_PREFIX="Dev"
    ;;
  staging)
    ENV_PREFIX="Staging"
    ;;
  prod|production)
    ENV_PREFIX="Prod"
    ;;
  *)
    echo -e "${RED}❌ Invalid environment: $ENVIRONMENT${NC}"
    echo "Valid environments: dev, staging, production"
    exit 1
    ;;
esac

echo -e "${BLUE}🚀 Starting deployment to $ENVIRONMENT environment${NC}"
echo -e "${BLUE}Environment prefix: $ENV_PREFIX${NC}"
echo -e "${BLUE}AWS Region: $AWS_REGION${NC}"

# Stack deployment order (respects dependencies)
STACKS=(
  "ShopSmart-${ENV_PREFIX}-SharedInfra"
  "ShopSmart-${ENV_PREFIX}-ProductCatalog"
  "ShopSmart-${ENV_PREFIX}-OrderProcessing"
  "ShopSmart-${ENV_PREFIX}-UserAuth"
  "ShopSmart-${ENV_PREFIX}-ServiceIntegration"
)

# Function to deploy a single stack
deploy_stack() {
  local stack_name=$1
  echo -e "${YELLOW}📦 Deploying stack: $stack_name${NC}"
  
  if cdk deploy "$stack_name" --require-approval never --context environment="$ENVIRONMENT"; then
    echo -e "${GREEN}✅ Successfully deployed: $stack_name${NC}"
    return 0
  else
    echo -e "${RED}❌ Failed to deploy: $stack_name${NC}"
    return 1
  fi
}

# Function to get stack outputs
get_stack_outputs() {
  local stack_name=$1
  echo -e "${BLUE}📋 Getting outputs for: $stack_name${NC}"
  
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs' \
    --output table 2>/dev/null || echo "No outputs available"
}

# Function to run health checks
run_health_checks() {
  echo -e "${YELLOW}🏥 Running health checks...${NC}"
  
  # Get ALB URL from ProductCatalog stack
  ALB_URL=$(aws cloudformation describe-stacks \
    --stack-name "ShopSmart-${ENV_PREFIX}-ProductCatalog" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text 2>/dev/null || echo "")
  
  if [[ -n "$ALB_URL" ]]; then
    echo -e "${BLUE}Testing ALB endpoint: http://$ALB_URL${NC}"
    
    # Wait for ALB to be ready
    echo "Waiting for services to be ready..."
    sleep 30
    
    # Basic health check
    if curl -f -s "http://$ALB_URL/health" >/dev/null 2>&1; then
      echo -e "${GREEN}✅ Health check passed${NC}"
    else
      echo -e "${YELLOW}⚠️ Health check endpoint not responding (this may be expected)${NC}"
    fi
  else
    echo -e "${YELLOW}⚠️ ALB URL not found, skipping health checks${NC}"
  fi
}

# Function to display deployment summary
show_deployment_summary() {
  echo -e "\n${BLUE}📊 Deployment Summary${NC}"
  echo "===================="
  echo "Environment: $ENVIRONMENT"
  echo "Region: $AWS_REGION"
  echo "Timestamp: $(date)"
  
  echo -e "\n${BLUE}📋 Stack Status:${NC}"
  for stack in "${STACKS[@]}"; do
    if [[ -n "$SPECIFIC_STACK" && "$stack" != "$SPECIFIC_STACK" ]]; then
      continue
    fi
    
    STATUS=$(aws cloudformation describe-stacks \
      --stack-name "$stack" \
      --region "$AWS_REGION" \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || echo "NOT_FOUND")
    
    if [[ "$STATUS" == "CREATE_COMPLETE" || "$STATUS" == "UPDATE_COMPLETE" ]]; then
      echo -e "  ${GREEN}✅ $stack: $STATUS${NC}"
    else
      echo -e "  ${RED}❌ $stack: $STATUS${NC}"
    fi
  done
  
  # Show key outputs
  echo -e "\n${BLUE}🔗 Key Resources:${NC}"
  
  # ALB URL
  ALB_URL=$(aws cloudformation describe-stacks \
    --stack-name "ShopSmart-${ENV_PREFIX}-ProductCatalog" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text 2>/dev/null || echo "Not available")
  echo "  Application URL: http://$ALB_URL"
  
  # API Gateway URL
  API_URL=$(aws cloudformation describe-stacks \
    --stack-name "ShopSmart-${ENV_PREFIX}-UserAuth" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayUrl`].OutputValue' \
    --output text 2>/dev/null || echo "Not available")
  echo "  API Gateway URL: $API_URL"
  
  # EKS Cluster
  EKS_CLUSTER=$(aws cloudformation describe-stacks \
    --stack-name "ShopSmart-${ENV_PREFIX}-OrderProcessing" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`EKSClusterName`].OutputValue' \
    --output text 2>/dev/null || echo "Not available")
  echo "  EKS Cluster: $EKS_CLUSTER"
}

# Main deployment logic
main() {
  # Pre-deployment checks
  echo -e "${YELLOW}🔍 Pre-deployment checks...${NC}"
  
  # Check AWS credentials
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo -e "${RED}❌ AWS credentials not configured${NC}"
    exit 1
  fi
  
  # Check CDK installation
  if ! command -v cdk &> /dev/null; then
    echo -e "${RED}❌ CDK CLI not installed${NC}"
    exit 1
  fi
  
  # Change to CDK directory
  cd "$CDK_DIR"
  
  # Build the application
  echo -e "${YELLOW}🔨 Building application...${NC}"
  npm run build
  
  # CDK bootstrap check
  echo -e "${YELLOW}🥾 Checking CDK bootstrap...${NC}"
  cdk bootstrap --context environment="$ENVIRONMENT" || true
  
  # Deploy stacks
  if [[ -n "$SPECIFIC_STACK" ]]; then
    echo -e "${YELLOW}📦 Deploying specific stack: $SPECIFIC_STACK${NC}"
    deploy_stack "$SPECIFIC_STACK"
  else
    echo -e "${YELLOW}📦 Deploying all stacks in dependency order...${NC}"
    for stack in "${STACKS[@]}"; do
      deploy_stack "$stack"
    done
  fi
  
  # Post-deployment tasks
  echo -e "${YELLOW}🔍 Post-deployment tasks...${NC}"
  run_health_checks
  show_deployment_summary
  
  echo -e "\n${GREEN}🎉 Deployment completed successfully!${NC}"
}

# Error handling
trap 'echo -e "${RED}❌ Deployment failed!${NC}"; exit 1' ERR

# Run main function
main "$@"
