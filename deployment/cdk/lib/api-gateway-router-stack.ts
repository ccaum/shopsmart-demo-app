import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ApiGatewayRouterConstruct } from './constructs/api-gateway-router-construct';

export interface ApiGatewayRouterStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  availabilityZones?: string[];
}

export class ApiGatewayRouterStack extends cdk.Stack {
  public readonly apiGatewayAlbDnsName: string;
  public readonly healthCheckLambdaArn: string;

  constructor(scope: Construct, id: string, props: ApiGatewayRouterStackProps) {
    super(scope, id, props);

    const availabilityZones = (props.availabilityZones || this.availabilityZones).slice(0, 3);

    // Import VPC and subnets from shared infrastructure stack
    const vpcId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-VpcId`);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: vpcId,
      availabilityZones,
    });

    // Import subnet IDs and create subnet objects
    const publicSubnets: ec2.ISubnet[] = [];
    const privateAppSubnets: ec2.ISubnet[] = [];

    // Import public subnets
    availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PublicSubnet${index + 1}Id`);
      publicSubnets.push(ec2.Subnet.fromSubnetId(this, `PublicSubnet${index + 1}`, subnetId));
    });

    // Import private app subnets
    availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PrivateAppSubnet${index + 1}Id`);
      privateAppSubnets.push(ec2.Subnet.fromSubnetId(this, `PrivateAppSubnet${index + 1}`, subnetId));
    });

    // Import service endpoints from other stacks
    const authServiceApiGatewayUrl = cdk.Fn.importValue(`${props.projectName}-${props.environment}-UserAuthApiGatewayUrl`);
    const productCatalogAlbDnsName = cdk.Fn.importValue(`${props.projectName}-${props.environment}-ProductCatalogALBDnsName`);
    const telemetryCollectorUrl = cdk.Fn.importValue(`${props.projectName}-${props.environment}-telemetry-url`);
    
    // Use SSM parameter instead of CloudFormation export to avoid cross-stack dependency issues
    const orderProcessingAlbDnsName = ssm.StringParameter.valueForStringParameter(
      this, 
      `/${props.projectName}/${props.environment}/order-processing/alb-dns-name`
    );
    
    // Use default service registry SSM prefix (service registry stack may not be deployed yet)
    const serviceRegistrySSMPrefix = `/${props.projectName}/${props.environment}/services`;

    // Create API Gateway Router
    const apiGatewayRouter = new ApiGatewayRouterConstruct(this, 'ApiGatewayRouter', {
      vpc: vpc,
      publicSubnets: publicSubnets,
      privateAppSubnets: privateAppSubnets,
      projectName: props.projectName,
      environment: props.environment,
      authServiceApiGatewayUrl: authServiceApiGatewayUrl,
      productCatalogAlbDnsName: productCatalogAlbDnsName,
      orderProcessingAlbDnsName: orderProcessingAlbDnsName,
      telemetryCollectorUrl: telemetryCollectorUrl,
      serviceRegistrySSMPrefix: serviceRegistrySSMPrefix,
    });

    // Set outputs
    this.apiGatewayAlbDnsName = apiGatewayRouter.apiGatewayAlbDnsName;
    this.healthCheckLambdaArn = apiGatewayRouter.healthCheckLambdaArn;

    // Export values for other stacks to consume
    new cdk.CfnOutput(this, 'ApiGatewayRouterALBDnsName', {
      value: this.apiGatewayAlbDnsName,
      exportName: `${props.projectName}-${props.environment}-ApiGatewayRouterALBDnsName`,
      description: 'DNS name of the API Gateway Router ALB',
    });

    new cdk.CfnOutput(this, 'ApiGatewayRouterHealthCheckLambdaArn', {
      value: this.healthCheckLambdaArn,
      exportName: `${props.projectName}-${props.environment}-ApiGatewayRouterHealthCheckLambdaArn`,
      description: 'ARN of the API Gateway Router Health Check Lambda',
    });

    new cdk.CfnOutput(this, 'ApiGatewayRouterEndpoint', {
      value: `http://${this.apiGatewayAlbDnsName}`,
      exportName: `${props.projectName}-${props.environment}-ApiGatewayRouterEndpoint`,
      description: 'API Gateway Router endpoint URL',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'ApiGatewayRouter');
    cdk.Tags.of(this).add('StackType', 'Integration');
  }
}