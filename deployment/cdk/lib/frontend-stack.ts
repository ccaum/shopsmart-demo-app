import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export interface FrontendStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly cloudfrontDomainName: string;
  public readonly bucketName: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // Import API Gateway URL
    const apiGatewayUrl = cdk.Fn.importValue(
      `${props.projectName}-${props.environment}-ApiGatewayRouterALBDnsName`
    );

    // S3 bucket for frontend static files
    const bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${props.projectName}-${props.environment}-frontend`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiGatewayUrl, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        '/health': {
          origin: new origins.HttpOrigin(apiGatewayUrl, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      defaultRootObject: 'storefront.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/storefront.html',
        },
      ],
    });

    // Deploy frontend files to S3
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../../src/frontend'), {
          exclude: ['deploy', 'build', 'README.md'],
        }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    this.cloudfrontDomainName = distribution.distributionDomainName;
    this.bucketName = bucket.bucketName;

    // Outputs
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.bucketName,
      description: 'Frontend S3 Bucket Name',
      exportName: `${props.projectName}-${props.environment}-FrontendBucketName`,
    });

    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${this.cloudfrontDomainName}`,
      description: 'CloudFront Distribution URL',
      exportName: `${props.projectName}-${props.environment}-CloudFrontURL`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront Distribution ID',
      exportName: `${props.projectName}-${props.environment}-CloudFrontDistributionId`,
    });
  }
}
