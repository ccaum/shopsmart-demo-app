# CloudFormation Template Deployment Guide

## Overview

This directory contains parameterized CloudFormation templates converted from CDK stacks. These templates are portable and can be deployed without CDK.

## UserAuth Stack

### What's Included ✅

The `userauth-template.yaml` creates:
- **3 DynamoDB Tables**: Users, Sessions, Carts
- **IAM Role**: Lambda execution role with DynamoDB and SSM access
- **3 Lambda Functions**: Register, Login, Logout
- **Security Group**: For Lambda VPC access
- **Parameterized**: All environment-specific values are parameters

### Prerequisites

1. **S3 Bucket** for Lambda code:
   ```bash
   # Create bucket for Lambda deployment packages
   aws s3 mb s3://my-lambda-code-bucket --region us-west-2
   ```

2. **VPC and Subnets**: Must exist before deployment
   ```bash
   # Get VPC ID
   aws ec2 describe-vpcs --filters "Name=tag:Name,Values=shopsmart-prod-vpc" \
     --query 'Vpcs[0].VpcId' --output text
   
   # Get Subnet IDs
   aws ec2 describe-subnets --filters "Name=tag:Name,Values=*private*" \
     --query 'Subnets[*].[SubnetId,Tags[?Key==`Name`].Value|[0]]' --output table
   ```

3. **SSM Parameters** (Optional - for OpenTelemetry):
   ```bash
   # Create Dynatrace endpoint parameter
   aws ssm put-parameter \
     --name /shopsmart/prod/opentelemetry/endpoint \
     --value "https://YOUR_TENANT.live.dynatrace.com" \
     --type String
   
   # Create Dynatrace API token parameter
   aws ssm put-parameter \
     --name /shopsmart/prod/opentelemetry/api-token \
     --value "YOUR_API_TOKEN" \
     --type SecureString
   ```

### Deployment Steps

#### Option 1: Automated Deployment (Recommended)

Use the provided deployment script that handles Lambda packaging:

```bash
# Set required environment variables
export LAMBDA_CODE_BUCKET=my-lambda-code-bucket
export AWS_REGION=us-west-2
export STACK_NAME=shopsmart-prod-userauth

# Update parameters file with your VPC/subnet IDs
vi userauth-parameters.json

# Run deployment script
./deploy-userauth.sh
```

The script will:
1. Package Lambda code with dependencies
2. Upload to S3
3. Deploy CloudFormation stack
4. Wait for completion
5. Display outputs

#### Option 2: Manual Deployment

**Step 1: Package Lambda Code**

```bash
cd ../src/services/auth

# Install dependencies
pip install -r requirements.txt -t package/

# Copy source files
cp *.py package/
cp -r middleware package/

# Create ZIP
cd package
zip -r ../auth-service.zip .
cd ..

# Upload to S3
aws s3 cp auth-service.zip s3://my-lambda-code-bucket/lambda/auth-service.zip
```

**Step 2: Update Parameters File**

Edit `userauth-parameters.json`:

```json
{
  "ParameterKey": "VpcId",
  "ParameterValue": "vpc-0123456789abcdef0"
},
{
  "ParameterKey": "LambdaCodeBucket",
  "ParameterValue": "my-lambda-code-bucket"
}
```

**Step 3: Validate Template**

```bash
aws cloudformation validate-template \
  --template-body file://userauth-template.yaml
```

**Step 4: Deploy Stack**

```bash
aws cloudformation create-stack \
  --stack-name shopsmart-prod-userauth \
  --template-body file://userauth-template.yaml \
  --parameters file://userauth-parameters.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags \
    Key=Environment,Value=prod \
    Key=Project,Value=shopsmart \
    Key=ManagedBy,Value=CloudFormation
```

**Step 5: Monitor Deployment**

```bash
aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-userauth \
  --query 'Stacks[0].StackStatus'

# Watch events
aws cloudformation describe-stack-events \
  --stack-name shopsmart-prod-userauth \
  --max-items 10
```

### Update Stack

To update Lambda code or configuration:

```bash
# Repackage and upload Lambda code
./deploy-userauth.sh

# Or manually:
aws cloudformation update-stack \
  --stack-name shopsmart-prod-userauth \
  --template-body file://userauth-template.yaml \
  --parameters file://userauth-parameters.json \
  --capabilities CAPABILITY_NAMED_IAM
```

### Delete Stack

```bash
aws cloudformation delete-stack \
  --stack-name shopsmart-prod-userauth
```

**Note**: DynamoDB tables have `DeletionPolicy: Retain` to prevent accidental data loss.

### Testing Lambda Functions

```bash
# Get function ARNs from stack outputs
aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-userauth \
  --query 'Stacks[0].Outputs'

# Test register function
aws lambda invoke \
  --function-name shopsmart-prod-auth-register \
  --payload '{"body": "{\"email\":\"test@example.com\",\"password\":\"Test123!\"}"}' \
  response.json

cat response.json
```

## What's Included vs CDK

### ✅ Fully Implemented
- DynamoDB tables with proper configuration
- IAM roles and policies
- Lambda functions with VPC configuration
- Security groups
- OpenTelemetry layer integration
- Environment variables
- Parameterization

### ⚠️ Not Included (Would require additional work)
- API Gateway REST API (add ~200 lines)
- CloudWatch Alarms (add ~100 lines)
- Custom domains and certificates
- WAF rules
- X-Ray tracing configuration

## Comparison: CDK vs CloudFormation

### This Template
- **Lines**: ~450 (template) + ~150 (deployment script) = 600 total
- **Deployment**: Requires S3 bucket and manual packaging
- **Updates**: Repackage and redeploy
- **Portability**: High - works anywhere with AWS CLI

### Original CDK
- **Lines**: ~500 TypeScript
- **Deployment**: `cdk deploy` (automatic packaging)
- **Updates**: `cdk deploy` (automatic)
- **Portability**: Requires CDK toolkit

## Next Steps

To add API Gateway:
1. Create REST API resource
2. Add methods (POST /register, POST /login, POST /logout)
3. Create Lambda integrations
4. Add CORS configuration
5. Create deployment and stage

Estimated additional: ~200 lines of CloudFormation

Would you like me to add API Gateway to the template?

