import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ServiceRegistryConstruct, ServiceEndpoint } from './constructs/service-registry-construct';

export interface ServiceIntegrationStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
}

export class ServiceIntegrationStack extends cdk.Stack {
  public readonly serviceRegistry: ServiceRegistryConstruct;

  constructor(scope: Construct, id: string, props: ServiceIntegrationStackProps) {
    super(scope, id, props);

    // Import service endpoints from other stacks
    const authServiceApiGatewayUrl = cdk.Fn.importValue(`${props.projectName}-${props.environment}-UserAuthApiGatewayUrl`);
    const productCatalogAlbDnsName = cdk.Fn.importValue(`${props.projectName}-${props.environment}-ProductCatalogALBDnsName`);
    
    // Use SSM parameter instead of CloudFormation export to avoid cross-stack dependency issues
    const orderProcessingAlbDnsName = ssm.StringParameter.valueForStringParameter(
      this, 
      `/${props.projectName}/${props.environment}/order-processing/alb-dns-name`
    );

    // Define service endpoints configuration
    const services: ServiceEndpoint[] = [
      {
        name: 'auth',
        endpoint: authServiceApiGatewayUrl,
        healthEndpoint: `${authServiceApiGatewayUrl}/health`,
        type: 'lambda',
        protocol: 'https',
        port: 443,
        internal: false, // External API Gateway
      },
      {
        name: 'product-catalog',
        endpoint: productCatalogAlbDnsName,
        healthEndpoint: '/health',
        type: 'ec2_asg',
        protocol: 'http',
        port: 80,
        internal: true, // Internal ALB
      },
      {
        name: 'order-processing',
        endpoint: orderProcessingAlbDnsName,
        healthEndpoint: '/health',
        type: 'ecs',
        protocol: 'http',
        port: 80,
        internal: true, // Internal ALB
      },
    ];

    // Create service registry
    this.serviceRegistry = new ServiceRegistryConstruct(this, 'ServiceRegistry', {
      projectName: props.projectName,
      environment: props.environment,
      services: services,
    });

    // Export service registry information for other stacks
    new cdk.CfnOutput(this, 'ServiceRegistrySSMPrefix', {
      value: this.serviceRegistry.ssmParameterPrefix,
      exportName: `${props.projectName}-${props.environment}-ServiceRegistrySSMPrefix`,
      description: 'SSM parameter prefix for service registry',
    });

    // Export individual service discovery endpoints for backward compatibility
    services.forEach(service => {
      const serviceName = service.name.charAt(0).toUpperCase() + service.name.slice(1).replace('-', '');
      
      new cdk.CfnOutput(this, `${serviceName}ServiceDiscoveryEndpoint`, {
        value: service.endpoint,
        exportName: `${props.projectName}-${props.environment}-${serviceName}ServiceDiscoveryEndpoint`,
        description: `Service discovery endpoint for ${service.name}`,
      });

      new cdk.CfnOutput(this, `${serviceName}ServiceDiscoveryHealthEndpoint`, {
        value: service.healthEndpoint,
        exportName: `${props.projectName}-${props.environment}-${serviceName}ServiceDiscoveryHealthEndpoint`,
        description: `Service discovery health endpoint for ${service.name}`,
      });

      // Full URL for easy consumption
      const fullUrl = service.port && service.port !== 80 && service.port !== 443 
        ? `${service.protocol}://${service.endpoint}:${service.port}`
        : `${service.protocol}://${service.endpoint}`;

      new cdk.CfnOutput(this, `${serviceName}ServiceDiscoveryFullUrl`, {
        value: fullUrl,
        exportName: `${props.projectName}-${props.environment}-${serviceName}ServiceDiscoveryFullUrl`,
        description: `Full service discovery URL for ${service.name}`,
      });
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'ServiceIntegration');
    cdk.Tags.of(this).add('StackType', 'Integration');
  }
}