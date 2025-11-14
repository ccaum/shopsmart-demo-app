import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { VpcConstruct } from './constructs/vpc-construct';
import { OpenTelemetryConstruct, OpenTelemetryConfig } from './constructs/opentelemetry-construct';
import { OpenTelemetrySecretsConstruct } from './constructs/opentelemetry-secrets-construct';

export interface SharedInfrastructureStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  vpcCidr: string;
  availabilityZones: string[];
  otelConfig: OpenTelemetryConfig;
}

export class SharedInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateAppSubnets: ec2.ISubnet[];
  public readonly privateDataSubnets: ec2.ISubnet[];
  public readonly openTelemetryConstruct: OpenTelemetryConstruct;
  public readonly otelSecrets: OpenTelemetrySecretsConstruct;

  constructor(scope: Construct, id: string, props: SharedInfrastructureStackProps) {
    super(scope, id, props);

    // Create VPC and networking components
    const vpcConstruct = new VpcConstruct(this, 'VPC', {
      vpcCidr: props.vpcCidr,
      availabilityZones: props.availabilityZones,
      projectName: props.projectName,
      environment: props.environment,
    });

    // Set public properties
    this.vpc = vpcConstruct.vpc;
    this.publicSubnets = vpcConstruct.publicSubnets;
    this.privateAppSubnets = vpcConstruct.privateAppSubnets;
    this.privateDataSubnets = vpcConstruct.privateDataSubnets;

    // Create OpenTelemetry secrets (shared across all microservices)
    this.otelSecrets = new OpenTelemetrySecretsConstruct(this, 'OpenTelemetrySecrets', {
      projectName: props.projectName,
      environment: props.environment,
    });

    // Export values for cross-stack references
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${props.projectName}-${props.environment}-VpcId`,
      description: 'VPC ID for ShopSmart application',
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      exportName: `${props.projectName}-${props.environment}-VpcCidr`,
      description: 'VPC CIDR block',
    });

    // Export public subnet IDs
    this.publicSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PublicSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        exportName: `${props.projectName}-${props.environment}-PublicSubnet${index + 1}Id`,
        description: `Public subnet ${index + 1} ID`,
      });
    });

    // Export private app subnet IDs
    this.privateAppSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PrivateAppSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        exportName: `${props.projectName}-${props.environment}-PrivateAppSubnet${index + 1}Id`,
        description: `Private app subnet ${index + 1} ID`,
      });
    });

    // Export private data subnet IDs
    this.privateDataSubnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PrivateDataSubnet${index + 1}Id`, {
        value: subnet.subnetId,
        exportName: `${props.projectName}-${props.environment}-PrivateDataSubnet${index + 1}Id`,
        description: `Private data subnet ${index + 1} ID`,
      });
    });

    // Export availability zones
    props.availabilityZones.forEach((az, index) => {
      new cdk.CfnOutput(this, `AvailabilityZone${index + 1}`, {
        value: az,
        exportName: `${props.projectName}-${props.environment}-AvailabilityZone${index + 1}`,
        description: `Availability zone ${index + 1}`,
      });
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('StackType', 'SharedInfrastructure');
  }
}
