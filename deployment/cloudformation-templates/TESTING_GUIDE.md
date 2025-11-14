# CloudFormation Template Testing Guide

## No Conflicts with CDK Deployment

The CloudFormation templates are designed to coexist with your existing CDK deployment:

### Resource Naming Strategy

All resources include a `StackSuffix` parameter (default: `cfn`) to avoid conflicts:

**CDK Resources:**
- Stack: `ShopSmart-UserAuth`
- DynamoDB: `shopsmart-prod-users`
- Lambda: `shopsmart-prod-auth-register`
- VPC: Uses existing shared VPC

**CloudFormation Resources:**
- Stack: `shopsmart-prod-cfn-sharedinfra`, `shopsmart-prod-cfn-userauth`
- DynamoDB: `shopsmart-prod-cfn-users`
- Lambda: `shopsmart-prod-cfn-auth-register`
- VPC: Creates new VPC with CIDR `10.1.0.0/16` (vs CDK's `10.0.0.0/16`)

### What Gets Created

**SharedInfra Stack:**
- New VPC (10.1.0.0/16)
- 3 Public subnets
- 3 Private subnets
- 3 NAT Gateways
- Internet Gateway
- Route tables

**UserAuth Stack:**
- 3 DynamoDB tables (with `-cfn-` suffix)
- 3 Lambda functions (with `-cfn-` suffix)
- IAM role (with `-cfn-` suffix)
- Security group

### No Conflicts

✅ **Different Stack Names**: CloudFormation uses different naming convention  
✅ **Different Resource Names**: All resources have `-cfn-` suffix  
✅ **Different VPC**: Uses 10.1.0.0/16 instead of 10.0.0.0/16  
✅ **No API Gateway**: Template doesn't create API Gateway (yet)  
✅ **No CloudFront**: Template doesn't create CloudFront  

## Testing the Deployment

### Prerequisites

1. **S3 Bucket** for Lambda code:
   ```bash
   aws s3 mb s3://my-test-lambda-bucket --region us-west-2
   ```

2. **AWS CLI** configured with appropriate credentials

3. **Sufficient IAM permissions** to create:
   - VPC, Subnets, NAT Gateways
   - DynamoDB tables
   - Lambda functions
   - IAM roles

### Deployment Steps

```bash
cd cloudformation-templates

# Set environment variables
export LAMBDA_CODE_BUCKET=my-test-lambda-bucket
export AWS_REGION=us-west-2
export STACK_SUFFIX=cfn

# Deploy both stacks
./deploy-all.sh
```

The script will:
1. Deploy SharedInfra stack (~10 minutes for NAT Gateways)
2. Extract VPC and subnet IDs
3. Package Lambda code
4. Upload to S3
5. Deploy UserAuth stack (~5 minutes)

### Verify Deployment

```bash
# Check stack status
aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-cfn-sharedinfra \
  --query 'Stacks[0].StackStatus'

aws cloudformation describe-stacks \
  --stack-name shopsmart-prod-cfn-userauth \
  --query 'Stacks[0].StackStatus'

# List created resources
aws cloudformation list-stack-resources \
  --stack-name shopsmart-prod-cfn-userauth

# Test Lambda function
aws lambda invoke \
  --function-name shopsmart-prod-cfn-auth-register \
  --payload '{"body": "{\"email\":\"test@example.com\",\"password\":\"Test123!\"}"}' \
  response.json

cat response.json
```

### Cost Estimate

**SharedInfra:**
- 3 NAT Gateways: ~$100/month
- 3 Elastic IPs: ~$11/month
- VPC: Free

**UserAuth:**
- DynamoDB (5 RCU/WCU): ~$3/month
- Lambda (minimal usage): ~$1/month
- CloudWatch Logs: ~$1/month

**Total: ~$116/month** (mostly NAT Gateways)

### Cleanup

```bash
# Delete UserAuth stack first
aws cloudformation delete-stack \
  --stack-name shopsmart-prod-cfn-userauth

# Wait for deletion
aws cloudformation wait stack-delete-complete \
  --stack-name shopsmart-prod-cfn-userauth

# Delete SharedInfra stack
aws cloudformation delete-stack \
  --stack-name shopsmart-prod-cfn-sharedinfra

# Wait for deletion
aws cloudformation wait stack-delete-complete \
  --stack-name shopsmart-prod-cfn-sharedinfra

# Delete S3 bucket
aws s3 rb s3://my-test-lambda-bucket --force
```

**Note**: DynamoDB tables have `DeletionPolicy: Retain` so they won't be deleted automatically. Delete manually if needed:

```bash
aws dynamodb delete-table --table-name shopsmart-prod-cfn-users
aws dynamodb delete-table --table-name shopsmart-prod-cfn-sessions
aws dynamodb delete-table --table-name shopsmart-prod-cfn-carts
```

## Troubleshooting

### Issue: NAT Gateway creation timeout
**Solution**: NAT Gateways take 5-10 minutes to create. Be patient.

### Issue: Lambda function fails to create
**Solution**: Check that Lambda code was uploaded to S3:
```bash
aws s3 ls s3://my-test-lambda-bucket/lambda/
```

### Issue: VPC CIDR conflict
**Solution**: Change VpcCidr parameter in `sharedinfra-parameters.json` to a different range.

### Issue: Insufficient IAM permissions
**Solution**: Ensure your IAM user/role has permissions for:
- `ec2:*` (VPC, subnets, NAT gateways)
- `dynamodb:*` (tables)
- `lambda:*` (functions)
- `iam:*` (roles, policies)
- `cloudformation:*` (stacks)

## Comparison with CDK Deployment

| Aspect | CDK Deployment | CloudFormation Test |
|--------|----------------|---------------------|
| **Stack Names** | ShopSmart-* | shopsmart-prod-cfn-* |
| **VPC CIDR** | 10.0.0.0/16 | 10.1.0.0/16 |
| **Resource Suffix** | None | -cfn- |
| **DynamoDB Tables** | shopsmart-prod-users | shopsmart-prod-cfn-users |
| **Lambda Functions** | shopsmart-prod-auth-* | shopsmart-prod-cfn-auth-* |
| **API Gateway** | Yes | No (not in template) |
| **CloudFront** | Yes | No (not in template) |

## Next Steps

After successful testing:

1. **Add API Gateway** to UserAuth template
2. **Add CloudWatch Alarms** for monitoring
3. **Convert other stacks** (ProductCatalog, OrderProcessing)
4. **Implement CI/CD** pipeline for CloudFormation deployments

## Ready to Test?

```bash
# Quick start
export LAMBDA_CODE_BUCKET=my-test-lambda-bucket
./deploy-all.sh
```

This will create a complete, isolated test environment that won't interfere with your existing CDK deployment.
