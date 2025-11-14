#!/bin/bash
#
# Deploy ShopSmart CloudFormation Stacks
# Deploys SharedInfra first, then UserAuth
#

set -e

REGION="${AWS_REGION:-us-west-2}"
LAMBDA_CODE_BUCKET="${LAMBDA_CODE_BUCKET:-}"
STACK_SUFFIX="${STACK_SUFFIX:-cfn}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}ShopSmart CloudFormation Deployment${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check prerequisites
if [ -z "$LAMBDA_CODE_BUCKET" ]; then
    echo -e "${RED}Error: LAMBDA_CODE_BUCKET environment variable not set${NC}"
    echo "Usage: LAMBDA_CODE_BUCKET=my-bucket ./deploy-all.sh"
    exit 1
fi

# Step 1: Deploy SharedInfra
echo -e "${YELLOW}Step 1: Deploying SharedInfra stack...${NC}"
aws cloudformation deploy \
  --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra \
  --template-file sharedinfra-template.yaml \
  --parameter-overrides file://sharedinfra-parameters.json \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo -e "${GREEN}✓ SharedInfra deployed${NC}"

# Get VPC and subnet IDs from stack outputs
echo -e "${YELLOW}Step 2: Getting VPC and subnet IDs...${NC}"
VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text)

SUBNET1=$(aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnet1Id`].OutputValue' \
  --output text)

SUBNET2=$(aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnet2Id`].OutputValue' \
  --output text)

SUBNET3=$(aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`PrivateSubnet3Id`].OutputValue' \
  --output text)

echo "VPC ID: $VPC_ID"
echo "Subnet 1: $SUBNET1"
echo "Subnet 2: $SUBNET2"
echo "Subnet 3: $SUBNET3"

# Step 3: Update UserAuth parameters with actual IDs
echo -e "${YELLOW}Step 3: Updating UserAuth parameters...${NC}"
cat > userauth-parameters-generated.json <<EOF
[
  {"ParameterKey": "Environment", "ParameterValue": "prod"},
  {"ParameterKey": "ProjectName", "ParameterValue": "shopsmart"},
  {"ParameterKey": "StackSuffix", "ParameterValue": "${STACK_SUFFIX}"},
  {"ParameterKey": "VpcId", "ParameterValue": "${VPC_ID}"},
  {"ParameterKey": "PrivateSubnet1Id", "ParameterValue": "${SUBNET1}"},
  {"ParameterKey": "PrivateSubnet2Id", "ParameterValue": "${SUBNET2}"},
  {"ParameterKey": "PrivateSubnet3Id", "ParameterValue": "${SUBNET3}"},
  {"ParameterKey": "UserTableReadCapacity", "ParameterValue": "5"},
  {"ParameterKey": "UserTableWriteCapacity", "ParameterValue": "5"},
  {"ParameterKey": "SessionTableReadCapacity", "ParameterValue": "5"},
  {"ParameterKey": "SessionTableWriteCapacity", "ParameterValue": "5"},
  {"ParameterKey": "LambdaMemorySize", "ParameterValue": "512"},
  {"ParameterKey": "LambdaTimeout", "ParameterValue": "30"},
  {"ParameterKey": "LambdaCodeBucket", "ParameterValue": "${LAMBDA_CODE_BUCKET}"},
  {"ParameterKey": "LambdaCodeKey", "ParameterValue": "lambda/auth-service.zip"}
]
EOF

# Step 4: Deploy UserAuth (using the existing script)
echo -e "${YELLOW}Step 4: Deploying UserAuth stack...${NC}"
LAMBDA_CODE_BUCKET=$LAMBDA_CODE_BUCKET \
STACK_NAME=shopsmart-prod-${STACK_SUFFIX}-userauth \
PARAMETERS_FILE=userauth-parameters-generated.json \
  ./deploy-userauth.sh

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ All Stacks Deployed Successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Deployed stacks:"
echo "  - shopsmart-prod-${STACK_SUFFIX}-sharedinfra"
echo "  - shopsmart-prod-${STACK_SUFFIX}-userauth"
echo ""
echo "To delete all stacks:"
echo "  aws cloudformation delete-stack --stack-name shopsmart-prod-${STACK_SUFFIX}-userauth"
echo "  aws cloudformation delete-stack --stack-name shopsmart-prod-${STACK_SUFFIX}-sharedinfra"
