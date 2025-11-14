#!/bin/bash
#
# Deploy UserAuth CloudFormation Stack
# This script packages Lambda code and deploys the stack
#

set -e

# Configuration
STACK_NAME="${STACK_NAME:-shopsmart-prod-userauth}"
REGION="${AWS_REGION:-us-west-2}"
LAMBDA_CODE_BUCKET="${LAMBDA_CODE_BUCKET:-}"
TEMPLATE_FILE="userauth-template.yaml"
PARAMETERS_FILE="userauth-parameters.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}UserAuth Stack Deployment${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check prerequisites
if [ -z "$LAMBDA_CODE_BUCKET" ]; then
    echo -e "${RED}Error: LAMBDA_CODE_BUCKET environment variable not set${NC}"
    echo "Usage: LAMBDA_CODE_BUCKET=my-bucket ./deploy-userauth.sh"
    exit 1
fi

# Step 1: Package Lambda code
echo -e "${YELLOW}Step 1: Packaging Lambda code...${NC}"
cd ../src/services/auth

# Create deployment package
rm -rf package auth-service.zip
mkdir -p package

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt -t package/ --quiet

# Copy source files
echo "Copying source files..."
cp *.py package/
cp -r middleware package/ 2>/dev/null || true

# Create ZIP
echo "Creating deployment package..."
cd package
zip -r ../auth-service.zip . -q
cd ..

echo -e "${GREEN}✓ Lambda package created: auth-service.zip${NC}"

# Step 2: Upload to S3
echo -e "${YELLOW}Step 2: Uploading Lambda code to S3...${NC}"
aws s3 cp auth-service.zip "s3://${LAMBDA_CODE_BUCKET}/lambda/auth-service.zip" --region "$REGION"
echo -e "${GREEN}✓ Lambda code uploaded to s3://${LAMBDA_CODE_BUCKET}/lambda/auth-service.zip${NC}"

# Step 3: Update parameters file
cd ../../..
cd cloudformation-templates
echo -e "${YELLOW}Step 3: Updating parameters file...${NC}"

# Create temporary parameters file with bucket name
cat "$PARAMETERS_FILE" | \
  sed "s/REPLACE_WITH_S3_BUCKET_NAME/${LAMBDA_CODE_BUCKET}/g" > "${PARAMETERS_FILE}.tmp"

echo -e "${GREEN}✓ Parameters file updated${NC}"

# Step 4: Validate template
echo -e "${YELLOW}Step 4: Validating CloudFormation template...${NC}"
aws cloudformation validate-template \
  --template-body "file://${TEMPLATE_FILE}" \
  --region "$REGION" > /dev/null

echo -e "${GREEN}✓ Template is valid${NC}"

# Step 5: Deploy stack
echo -e "${YELLOW}Step 5: Deploying CloudFormation stack...${NC}"
echo "Stack name: $STACK_NAME"
echo "Region: $REGION"
echo ""

# Check if stack exists
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" &>/dev/null; then
    echo "Stack exists, updating..."
    aws cloudformation update-stack \
      --stack-name "$STACK_NAME" \
      --template-body "file://${TEMPLATE_FILE}" \
      --parameters "file://${PARAMETERS_FILE}.tmp" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION"
    
    echo "Waiting for stack update to complete..."
    aws cloudformation wait stack-update-complete \
      --stack-name "$STACK_NAME" \
      --region "$REGION"
else
    echo "Stack does not exist, creating..."
    aws cloudformation create-stack \
      --stack-name "$STACK_NAME" \
      --template-body "file://${TEMPLATE_FILE}" \
      --parameters "file://${PARAMETERS_FILE}.tmp" \
      --capabilities CAPABILITY_NAMED_IAM \
      --tags \
        Key=Environment,Value=prod \
        Key=Project,Value=shopsmart \
        Key=ManagedBy,Value=CloudFormation \
      --region "$REGION"
    
    echo "Waiting for stack creation to complete..."
    aws cloudformation wait stack-create-complete \
      --stack-name "$STACK_NAME" \
      --region "$REGION"
fi

# Cleanup
rm -f "${PARAMETERS_FILE}.tmp"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Show outputs
echo "Stack Outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table

echo ""
echo "To view stack details:"
echo "  aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION"
echo ""
echo "To delete stack:"
echo "  aws cloudformation delete-stack --stack-name $STACK_NAME --region $REGION"
