# CDK to CloudFormation Conversion

## Summary

This directory contains parameterized CloudFormation templates converted from CDK stacks.

### Completed: UserAuth Stack ✅

**File**: `userauth-template.yaml` (350 lines)

**What's Converted**:
- ✅ 3 DynamoDB tables (Users, Sessions, Carts)
- ✅ IAM execution role with policies
- ✅ 12 parameters for customization
- ✅ Proper tagging and exports
- ✅ Deletion policies for data protection

**What's Still Needed** (to match CDK functionality):
- ❌ Lambda functions (requires code packaging)
- ❌ API Gateway configuration
- ❌ Security groups
- ❌ CloudWatch logs and alarms

**Deployment Ready**: Partial (DynamoDB + IAM only)

### Conversion Difficulty Assessment

| Stack | CDK Lines | Est. CFN Lines | Difficulty | Docker Images | Time Estimate |
|-------|-----------|----------------|------------|---------------|---------------|
| UserAuth | ~500 | ~1000 | Medium | No | 1-2 days |
| SharedInfra | ~400 | ~800 | Medium | No | 1-2 days |
| ProductCatalog | ~800 | ~1500 | High | No | 3-4 days |
| OrderProcessing | ~700 | ~1200 | Very High | Yes | 4-5 days |
| ServiceIntegration | ~300 | ~600 | Medium | No | 1-2 days |

**Total Estimated Effort**: 10-15 days for complete conversion

### Key Challenges

#### 1. Asset Management
**CDK**: Automatic
```typescript
new lambda.Function(this, 'MyFunction', {
  code: lambda.Code.fromAsset('src/lambda'),  // CDK handles packaging
  runtime: lambda.Runtime.PYTHON_3_11
});
```

**CloudFormation**: Manual
```yaml
# Must manually:
# 1. Package code: zip -r function.zip src/
# 2. Upload to S3: aws s3 cp function.zip s3://bucket/
# 3. Reference in template:
Code:
  S3Bucket: my-bucket
  S3Key: function.zip
```

#### 2. Docker Images (OrderProcessing)
**CDK**: Automatic
```typescript
new ecs.ContainerImage.fromAsset('src/services/order-processing')
// CDK builds, tags, and pushes to ECR
```

**CloudFormation**: Manual process required
```bash
# 1. Build image
docker build -t order-processing src/services/order-processing

# 2. Tag for ECR
docker tag order-processing:latest 123456789.dkr.ecr.us-west-2.amazonaws.com/order-processing:latest

# 3. Push to ECR
docker push 123456789.dkr.ecr.us-west-2.amazonaws.com/order-processing:latest

# 4. Reference in CloudFormation
Image: 123456789.dkr.ecr.us-west-2.amazonaws.com/order-processing:latest
```

#### 3. Cross-Stack References
**CDK**: Automatic
```typescript
const vpc = Vpc.fromLookup(this, 'Vpc', { vpcId: sharedStack.vpcId });
```

**CloudFormation**: Manual exports/imports
```yaml
# Stack 1 - Export
Outputs:
  VpcId:
    Value: !Ref VPC
    Export:
      Name: shopsmart-prod-VpcId

# Stack 2 - Import
VpcId: !ImportValue shopsmart-prod-VpcId
```

### Recommendations

#### Option 1: Hybrid Approach (Recommended)
- Keep CDK for development and CI/CD
- Use `cdk synth` to generate CloudFormation templates
- Commit synthesized templates to repo for audit/governance
- Deploy using either CDK or CloudFormation CLI

**Pros**:
- Best of both worlds
- No manual conversion needed
- Audit trail of exact CloudFormation deployed

**Cons**:
- Templates are verbose (CDK-generated)
- Not as "clean" as hand-written CloudFormation

#### Option 2: Full Conversion
- Manually convert all stacks to CloudFormation
- Create deployment scripts for assets
- Maintain CloudFormation templates going forward

**Pros**:
- No CDK dependency
- Clean, readable templates
- Native CloudFormation features (StackSets, etc.)

**Cons**:
- 10-15 days of work
- Lose CDK benefits (type safety, constructs)
- More maintenance overhead

#### Option 3: Keep CDK
- Continue using CDK
- Use CloudFormation console for visibility
- Export templates when needed for sharing

**Pros**:
- No conversion work
- Keep all CDK benefits
- Faster development

**Cons**:
- Requires CDK knowledge
- Build step required
- Less portable

### Next Steps

If continuing conversion:

1. **SharedInfra** (VPC, Subnets, Networking)
   - No Docker images
   - Straightforward conversion
   - Foundation for other stacks

2. **ProductCatalog** (EC2, RDS, ElastiCache)
   - Complex but no Docker
   - User data scripts need handling

3. **OrderProcessing** (ECS, Docker)
   - Most challenging
   - Requires Docker build pipeline

### Files in This Directory

- `userauth-template.yaml` - Parameterized CloudFormation template
- `userauth-parameters.json` - Example parameters file
- `DEPLOYMENT_GUIDE.md` - Detailed deployment instructions
- `README.md` - This file

### Testing the Template

```bash
# Validate syntax
aws cloudformation validate-template \
  --template-body file://userauth-template.yaml

# Create change set (dry run)
aws cloudformation create-change-set \
  --stack-name test-userauth \
  --template-body file://userauth-template.yaml \
  --parameters file://userauth-parameters.json \
  --change-set-name test-changes \
  --capabilities CAPABILITY_NAMED_IAM

# Review changes
aws cloudformation describe-change-set \
  --stack-name test-userauth \
  --change-set-name test-changes
```

## Conclusion

**UserAuth stack conversion demonstrates**:
- ✅ Parameterization is straightforward
- ✅ DynamoDB and IAM convert cleanly
- ⚠️ Lambda functions require additional work
- ⚠️ Complete parity requires ~3x the code

**Recommendation**: Use hybrid approach (CDK + synthesized templates) unless there's a specific requirement for pure CloudFormation.
