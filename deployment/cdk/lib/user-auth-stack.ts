import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { UserAuthConstruct } from './constructs/user-auth-construct';

export interface UserAuthStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  availabilityZones?: string[];
  
  // User Authentication Service configuration
  dynamodbReadCapacity: number;
  dynamodbWriteCapacity: number;
  lambdaLoginMemory: number;
}

export class UserAuthStack extends cdk.Stack {
  public readonly apiGatewayUrl: string;
  public readonly lambdaExecutionRoleArn: string;

  constructor(scope: Construct, id: string, props: UserAuthStackProps) {
    super(scope, id, props);

    const availabilityZones = (props.availabilityZones || this.availabilityZones).slice(0, 3);

    // Import VPC and subnets from shared infrastructure stack
    const vpcId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-VpcId`);
    const vpcCidr = cdk.Fn.importValue(`${props.projectName}-${props.environment}-VpcCidr`);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones,
    });

    // Import subnet IDs and create subnet objects
    const privateAppSubnets: ec2.ISubnet[] = [];

    // Import private app subnets
    availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PrivateAppSubnet${index + 1}Id`);
      privateAppSubnets.push(ec2.Subnet.fromSubnetId(this, `PrivateAppSubnet${index + 1}`, subnetId));
    });

    // OpenTelemetry Lambda Layer (AWS Distro for OpenTelemetry)
    const otelLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'OTelLayer',
      `arn:aws:lambda:${this.region}:901920570463:layer:aws-otel-python-amd64-ver-1-20-0:1`
    );

    // Create User Authentication Service
    const userAuth = new UserAuthConstruct(this, 'UserAuth', {
      vpc: vpc,
      privateAppSubnets: privateAppSubnets,
      projectName: props.projectName,
      environment: props.environment,
      
      // Deliberately undersized DynamoDB capacity to match throttling issues
      dynamodbReadCapacity: props.dynamodbReadCapacity,
      dynamodbWriteCapacity: props.dynamodbWriteCapacity,
      
      // Deliberately high memory for Lambda to match overprovisioning
      lambdaLoginMemory: props.lambdaLoginMemory,
      otelLayer: otelLayer,
    });

    // Set outputs
    this.apiGatewayUrl = userAuth.apiGatewayUrl;
    this.lambdaExecutionRoleArn = userAuth.lambdaExecutionRoleArn;

    // Export values for other stacks to consume
    new cdk.CfnOutput(this, 'UserAuthApiGatewayUrl', {
      value: this.apiGatewayUrl,
      exportName: `${props.projectName}-${props.environment}-UserAuthApiGatewayUrl`,
      description: 'URL of the User Authentication API Gateway',
    });

    new cdk.CfnOutput(this, 'UserAuthLambdaExecutionRoleArn', {
      value: this.lambdaExecutionRoleArn,
      exportName: `${props.projectName}-${props.environment}-UserAuthLambdaExecutionRoleArn`,
      description: 'ARN of the Lambda execution role for User Authentication',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'UserAuthentication');
    cdk.Tags.of(this).add('StackType', 'Microservice');
  }
}
