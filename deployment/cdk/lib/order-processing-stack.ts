import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { OrderProcessingEcsConstruct } from './constructs/order-processing-construct-ecs';

export interface OrderProcessingStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  availabilityZones: string[];
  
  // Order Processing Service configuration (using ECS instead of EKS)
  eksNodeInstanceType: string; // Renamed but keeping for compatibility
  eksMinNodes: number;
  eksMaxNodes: number;
  eksDesiredNodes: number;
  mongodbCpuLimit: string;
  mongodbMemoryLimit: string;
  mongodbStorageSize: string;
}

export class OrderProcessingStack extends cdk.Stack {
  public readonly clusterName: string;
  public readonly serviceArn: string;

  constructor(scope: Construct, id: string, props: OrderProcessingStackProps) {
    super(scope, id, props);

    // Import VPC and subnets from shared infrastructure stack
    const vpcId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-VpcId`);
    const vpcCidr = cdk.Fn.importValue(`${props.projectName}-${props.environment}-VpcCidr`);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones: props.availabilityZones,
    });

    // Import subnet IDs and create subnet objects
    const publicSubnets: ec2.ISubnet[] = [];
    const privateAppSubnets: ec2.ISubnet[] = [];

    // Import public subnets
    props.availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PublicSubnet${index + 1}Id`);
      publicSubnets.push(ec2.Subnet.fromSubnetId(this, `PublicSubnet${index + 1}`, subnetId));
    });

    // Import private app subnets
    props.availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PrivateAppSubnet${index + 1}Id`);
      privateAppSubnets.push(ec2.Subnet.fromSubnetId(this, `PrivateAppSubnet${index + 1}`, subnetId));
    });

    // Create Order Processing Service using ECS
    const orderProcessing = new OrderProcessingEcsConstruct(this, 'OrderProcessing', {
      vpc: vpc,
      publicSubnets: publicSubnets,
      privateAppSubnets: privateAppSubnets,
      availabilityZones: props.availabilityZones,
      projectName: props.projectName,
      environment: props.environment,
      
      // Deliberately oversized ECS instances to match underutilization issue
      ecsInstanceType: props.eksNodeInstanceType, // Reusing the same instance type
      ecsMinCapacity: props.eksMinNodes,
      ecsMaxCapacity: props.eksMaxNodes,
      ecsDesiredCapacity: props.eksDesiredNodes,
      
      // Deliberately oversized MongoDB resources
      mongodbCpuLimit: parseInt(props.mongodbCpuLimit) * 1024, // Convert to CPU units
      mongodbMemoryLimit: parseInt(props.mongodbMemoryLimit.replace('Gi', '')) * 1024, // Convert to MiB
      mongodbStorageSize: props.mongodbStorageSize,
    });

    // Set outputs
    this.clusterName = orderProcessing.clusterName;
    this.serviceArn = orderProcessing.serviceArn;

    // Export values for other stacks to consume
    new cdk.CfnOutput(this, 'OrderProcessingClusterName', {
      value: this.clusterName,
      exportName: `${props.projectName}-${props.environment}-OrderProcessingClusterName`,
      description: 'Name of the ECS cluster for Order Processing',
    });

    new cdk.CfnOutput(this, 'OrderProcessingServiceArn', {
      value: this.serviceArn,
      exportName: `${props.projectName}-${props.environment}-OrderProcessingServiceArn`,
      description: 'ARN of the ECS service for Order Processing',
    });

    // Store ALB DNS name in SSM Parameter instead of CloudFormation export
    // This prevents cross-stack dependency issues during updates
    new ssm.StringParameter(this, 'OrderProcessingALBDnsNameParameter', {
      parameterName: `/${props.projectName}/${props.environment}/order-processing/alb-dns-name`,
      stringValue: orderProcessing.albDnsName,
      description: 'DNS name of the Order Processing ALB',
    });

    // Keep the output for backwards compatibility but remove the export
    new cdk.CfnOutput(this, 'OrderProcessingALBDnsName', {
      value: orderProcessing.albDnsName,
      description: 'DNS name of the Order Processing ALB',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'OrderProcessing');
    cdk.Tags.of(this).add('StackType', 'Microservice');
  }
}
