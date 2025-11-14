import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcConstructProps {
  vpcCidr: string;
  availabilityZones: string[];
  projectName: string;
  environment: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateAppSubnets: ec2.ISubnet[];
  public readonly privateDataSubnets: ec2.ISubnet[];

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    // Create VPC
    this.vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      availabilityZones: props.availabilityZones,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateApp',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'PrivateData',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      natGateways: 1, // Reduced to 1 to avoid EIP limit issues
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // Tag the VPC
    cdk.Tags.of(this.vpc).add('Name', `${props.projectName}-${props.environment}-vpc`);
    cdk.Tags.of(this.vpc).add('Environment', props.environment);
    cdk.Tags.of(this.vpc).add('Project', props.projectName);

    // Get subnet references
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateAppSubnets = this.vpc.privateSubnets.filter(subnet => 
      subnet.node.id.includes('PrivateApp')
    );
    this.privateDataSubnets = this.vpc.isolatedSubnets;

    // Create VPC Endpoints for AWS services (cost optimization)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Interface endpoints for other AWS services
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Tag subnets appropriately
    this.publicSubnets.forEach((subnet, index) => {
      cdk.Tags.of(subnet).add('Name', `${props.projectName}-${props.environment}-public-${index + 1}`);
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    });

    this.privateAppSubnets.forEach((subnet, index) => {
      cdk.Tags.of(subnet).add('Name', `${props.projectName}-${props.environment}-private-app-${index + 1}`);
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    });

    this.privateDataSubnets.forEach((subnet, index) => {
      cdk.Tags.of(subnet).add('Name', `${props.projectName}-${props.environment}-private-data-${index + 1}`);
    });
  }
}
