import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ProductCatalogConstruct } from './constructs/product-catalog-construct';

export interface ProductCatalogStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  availabilityZones: string[];
  
  // Product Catalog Service configuration
  ec2InstanceType: string;
  rdsInstanceType: string;
  elasticacheNodeType: string;
  asgMinSize: number;
  asgMaxSize: number;
  asgDesiredCapacity: number;
}

export class ProductCatalogStack extends cdk.Stack {
  public readonly albDnsName: string;
  public readonly rdsEndpoint: string;
  public readonly redisEndpoint: string;
  public readonly catalogUpdatesTopicArn: string;

  constructor(scope: Construct, id: string, props: ProductCatalogStackProps) {
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
    const privateDataSubnets: ec2.ISubnet[] = [];

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

    // Import private data subnets
    props.availabilityZones.forEach((az, index) => {
      const subnetId = cdk.Fn.importValue(`${props.projectName}-${props.environment}-PrivateDataSubnet${index + 1}Id`);
      privateDataSubnets.push(ec2.Subnet.fromSubnetId(this, `PrivateDataSubnet${index + 1}`, subnetId));
    });

    // Import API Gateway Router ALB DNS name (if available)
    // TEMPORARILY DISABLED to break circular dependency for stack deletion
    let apiGatewayRouterAlbDnsName: string | undefined;
    apiGatewayRouterAlbDnsName = undefined;
    // try {
    //   apiGatewayRouterAlbDnsName = cdk.Fn.importValue(`${props.projectName}-${props.environment}-ApiGatewayRouterALBDnsName`);
    // } catch (error) {
    //   // API Gateway Router stack may not be deployed yet
    //   apiGatewayRouterAlbDnsName = undefined;
    // }

    // Create Product Catalog Service
    const productCatalog = new ProductCatalogConstruct(this, 'ProductCatalog', {
      vpc: vpc,
      publicSubnets: publicSubnets,
      privateAppSubnets: privateAppSubnets,
      privateDataSubnets: privateDataSubnets,
      availabilityZones: props.availabilityZones,
      projectName: props.projectName,
      environment: props.environment,
      
      // Deliberately undersized RDS instance to match the IOPS limits issue
      rdsInstanceType: props.rdsInstanceType,
      
      // Deliberately oversized EC2 instances to match the underutilization issue
      ec2InstanceType: props.ec2InstanceType,
      
      // Deliberately oversized ElastiCache nodes
      elasticacheNodeType: props.elasticacheNodeType,
      
      // Min instances set high to match overprovisioning issue
      asgMinSize: props.asgMinSize,
      asgMaxSize: props.asgMaxSize,
      asgDesiredCapacity: props.asgDesiredCapacity,
      apiGatewayRouterAlbDnsName: apiGatewayRouterAlbDnsName,
    });

    // Set outputs
    this.albDnsName = productCatalog.albDnsName;
    this.rdsEndpoint = productCatalog.rdsEndpoint;
    this.redisEndpoint = productCatalog.redisEndpoint;
    this.catalogUpdatesTopicArn = productCatalog.catalogUpdatesTopic.topicArn;

    // Export values for other stacks to consume
    new cdk.CfnOutput(this, 'ProductCatalogALBDnsName', {
      value: this.albDnsName,
      exportName: `${props.projectName}-${props.environment}-ProductCatalogALBDnsName`,
      description: 'DNS name of the Product Catalog ALB',
    });

    new cdk.CfnOutput(this, 'ProductCatalogRdsEndpoint', {
      value: this.rdsEndpoint,
      exportName: `${props.projectName}-${props.environment}-ProductCatalogRdsEndpoint`,
      description: 'Endpoint of the Product Catalog RDS instance',
    });

    new cdk.CfnOutput(this, 'ProductCatalogRedisEndpoint', {
      value: this.redisEndpoint,
      exportName: `${props.projectName}-${props.environment}-ProductCatalogRedisEndpoint`,
      description: 'Endpoint of the Product Catalog Redis cluster',
    });



    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'ProductCatalog');
    cdk.Tags.of(this).add('StackType', 'Microservice');
  }
}
