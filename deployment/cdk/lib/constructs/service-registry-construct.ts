import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ServiceEndpoint {
  name: string;
  endpoint: string;
  healthEndpoint: string;
  type: 'lambda' | 'ec2_asg' | 'ecs';
  protocol: 'http' | 'https';
  port?: number;
  internal?: boolean; // Whether this is an internal service endpoint
}

export interface ServiceRegistryConstructProps {
  projectName: string;
  environment: string;
  services: ServiceEndpoint[];
}

export class ServiceRegistryConstruct extends Construct {
  public readonly serviceRegistry: { [key: string]: ServiceEndpoint };
  public readonly ssmParameterPrefix: string;

  constructor(scope: Construct, id: string, props: ServiceRegistryConstructProps) {
    super(scope, id);

    this.ssmParameterPrefix = `/${props.projectName}/${props.environment}/services`;
    this.serviceRegistry = {};

    // Create service registry from provided services
    props.services.forEach(service => {
      this.serviceRegistry[service.name] = service;
      
      // Create SSM parameters for each service
      this.createServiceSSMParameters(service, props);
      
      // Create CloudFormation outputs for cross-stack references
      this.createServiceOutputs(service, props);
    });

    // Create a consolidated service registry SSM parameter
    const serviceRegistryJson = JSON.stringify({
      services: this.serviceRegistry,
      lastUpdated: new Date().toISOString(),
      environment: props.environment
    }, null, 2);

    new ssm.StringParameter(this, 'ServiceRegistryParameter', {
      parameterName: `${this.ssmParameterPrefix}/registry`,
      stringValue: serviceRegistryJson,
      description: `Service registry for ${props.projectName} ${props.environment} environment`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // Create service discovery helper parameters
    this.createServiceDiscoveryHelpers(props);

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Component', 'ServiceRegistry');
  }

  private createServiceSSMParameters(service: ServiceEndpoint, props: ServiceRegistryConstructProps): void {
    const servicePrefix = `${this.ssmParameterPrefix}/${service.name}`;

    // Service endpoint
    new ssm.StringParameter(this, `${service.name}EndpointParameter`, {
      parameterName: `${servicePrefix}/endpoint`,
      stringValue: service.endpoint,
      description: `Endpoint URL for ${service.name} service`,
    });

    // Health check endpoint
    new ssm.StringParameter(this, `${service.name}HealthEndpointParameter`, {
      parameterName: `${servicePrefix}/health_endpoint`,
      stringValue: service.healthEndpoint,
      description: `Health check endpoint for ${service.name} service`,
    });

    // Service type
    new ssm.StringParameter(this, `${service.name}TypeParameter`, {
      parameterName: `${servicePrefix}/type`,
      stringValue: service.type,
      description: `Service type for ${service.name}`,
    });

    // Protocol
    new ssm.StringParameter(this, `${service.name}ProtocolParameter`, {
      parameterName: `${servicePrefix}/protocol`,
      stringValue: service.protocol,
      description: `Protocol for ${service.name} service`,
    });

    // Port (if specified)
    if (service.port) {
      new ssm.StringParameter(this, `${service.name}PortParameter`, {
        parameterName: `${servicePrefix}/port`,
        stringValue: service.port.toString(),
        description: `Port for ${service.name} service`,
      });
    }

    // Internal flag
    new ssm.StringParameter(this, `${service.name}InternalParameter`, {
      parameterName: `${servicePrefix}/internal`,
      stringValue: service.internal ? 'true' : 'false',
      description: `Internal service flag for ${service.name}`,
    });

    // Full service URL (computed)
    const fullUrl = service.port && service.port !== 80 && service.port !== 443 
      ? `${service.protocol}://${service.endpoint}:${service.port}`
      : `${service.protocol}://${service.endpoint}`;

    new ssm.StringParameter(this, `${service.name}FullUrlParameter`, {
      parameterName: `${servicePrefix}/full_url`,
      stringValue: fullUrl,
      description: `Full URL for ${service.name} service`,
    });

    // Health check URL (computed)
    const healthUrl = service.healthEndpoint.startsWith('http') 
      ? service.healthEndpoint 
      : `${fullUrl}${service.healthEndpoint}`;

    new ssm.StringParameter(this, `${service.name}HealthUrlParameter`, {
      parameterName: `${servicePrefix}/health_url`,
      stringValue: healthUrl,
      description: `Full health check URL for ${service.name} service`,
    });
  }

  private createServiceOutputs(service: ServiceEndpoint, props: ServiceRegistryConstructProps): void {
    const outputPrefix = `${props.projectName}${props.environment}${service.name.charAt(0).toUpperCase() + service.name.slice(1)}`;

    // Service endpoint output
    new cdk.CfnOutput(this, `${service.name}EndpointOutput`, {
      value: service.endpoint,
      exportName: `${outputPrefix}Endpoint`,
      description: `Endpoint for ${service.name} service`,
    });

    // Health endpoint output
    new cdk.CfnOutput(this, `${service.name}HealthEndpointOutput`, {
      value: service.healthEndpoint,
      exportName: `${outputPrefix}HealthEndpoint`,
      description: `Health endpoint for ${service.name} service`,
    });

    // Service type output
    new cdk.CfnOutput(this, `${service.name}TypeOutput`, {
      value: service.type,
      exportName: `${outputPrefix}Type`,
      description: `Type of ${service.name} service`,
    });

    // Full URL output
    const fullUrl = service.port && service.port !== 80 && service.port !== 443 
      ? `${service.protocol}://${service.endpoint}:${service.port}`
      : `${service.protocol}://${service.endpoint}`;

    new cdk.CfnOutput(this, `${service.name}FullUrlOutput`, {
      value: fullUrl,
      exportName: `${outputPrefix}FullUrl`,
      description: `Full URL for ${service.name} service`,
    });
  }

  private createServiceDiscoveryHelpers(props: ServiceRegistryConstructProps): void {
    // Create a parameter with all service names for easy discovery
    const serviceNames = Object.keys(this.serviceRegistry);
    new ssm.StringParameter(this, 'ServiceNamesParameter', {
      parameterName: `${this.ssmParameterPrefix}/names`,
      stringValue: JSON.stringify(serviceNames),
      description: `List of all service names in ${props.environment} environment`,
    });

    // Create parameters for different service types
    const servicesByType: { [key: string]: string[] } = {};
    Object.values(this.serviceRegistry).forEach(service => {
      if (!servicesByType[service.type]) {
        servicesByType[service.type] = [];
      }
      servicesByType[service.type].push(service.name);
    });

    Object.entries(servicesByType).forEach(([type, services]) => {
      new ssm.StringParameter(this, `${type}ServicesParameter`, {
        parameterName: `${this.ssmParameterPrefix}/by_type/${type}`,
        stringValue: JSON.stringify(services),
        description: `List of ${type} services in ${props.environment} environment`,
      });
    });

    // Create internal vs external service lists
    const internalServices = Object.values(this.serviceRegistry)
      .filter(service => service.internal)
      .map(service => service.name);
    
    const externalServices = Object.values(this.serviceRegistry)
      .filter(service => !service.internal)
      .map(service => service.name);

    new ssm.StringParameter(this, 'InternalServicesParameter', {
      parameterName: `${this.ssmParameterPrefix}/internal`,
      stringValue: JSON.stringify(internalServices),
      description: `List of internal services in ${props.environment} environment`,
    });

    new ssm.StringParameter(this, 'ExternalServicesParameter', {
      parameterName: `${this.ssmParameterPrefix}/external`,
      stringValue: JSON.stringify(externalServices),
      description: `List of external services in ${props.environment} environment`,
    });
  }

  /**
   * Get service endpoint by name
   */
  public getServiceEndpoint(serviceName: string): ServiceEndpoint | undefined {
    return this.serviceRegistry[serviceName];
  }

  /**
   * Get all services of a specific type
   */
  public getServicesByType(type: string): ServiceEndpoint[] {
    return Object.values(this.serviceRegistry).filter(service => service.type === type);
  }

  /**
   * Get all internal services
   */
  public getInternalServices(): ServiceEndpoint[] {
    return Object.values(this.serviceRegistry).filter(service => service.internal);
  }

  /**
   * Get all external services
   */
  public getExternalServices(): ServiceEndpoint[] {
    return Object.values(this.serviceRegistry).filter(service => !service.internal);
  }
}