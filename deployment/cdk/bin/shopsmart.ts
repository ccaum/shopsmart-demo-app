#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedInfrastructureStack } from '../lib/shared-infrastructure-stack';
import { ProductCatalogStack } from '../lib/product-catalog-stack';
import { OrderProcessingStack } from '../lib/order-processing-stack';
import { UserAuthStack } from '../lib/user-auth-stack';
import { ServiceIntegrationStack } from '../lib/service-integration-stack';
import { ApiGatewayRouterStack } from '../lib/api-gateway-router-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { OtelCollectorStack } from '../lib/otel-collector-stack';
import { FrontendStack } from '../lib/frontend-stack';

const app = new cdk.App();

// Add Application tag to ALL resources in the app
cdk.Tags.of(app).add('Application', 'ShopSmart');

// Common configuration
const projectName = 'shopsmart';
const environment = process.env.ENVIRONMENT || 'prod-v2'; // Changed to prod-v2 for unique exports
const region = process.env.CDK_DEFAULT_REGION || 'us-west-2';
const account = process.env.CDK_DEFAULT_ACCOUNT;

// OpenTelemetry configuration per environment (using Dynatrace as backend)
const otelConfig = {
  dev: {
    endpoint: process.env.DYNATRACE_DEV_ENDPOINT || 'https://dev.live.dynatrace.com',
    apiToken: process.env.DYNATRACE_DEV_API_TOKEN,
    environmentId: process.env.DYNATRACE_DEV_ENV_ID
  },
  staging: {
    endpoint: process.env.DYNATRACE_STAGING_ENDPOINT || 'https://staging.live.dynatrace.com',
    apiToken: process.env.DYNATRACE_STAGING_API_TOKEN,
    environmentId: process.env.DYNATRACE_STAGING_ENV_ID
  },
  prod: {
    endpoint: process.env.DYNATRACE_PROD_ENDPOINT || 'https://prod.live.dynatrace.com',
    apiToken: process.env.DYNATRACE_PROD_API_TOKEN,
    environmentId: process.env.DYNATRACE_PROD_ENV_ID
  }
};

const commonProps = {
  env: { account, region },
  projectName,
  environment,
  availabilityZones: ['us-west-2a', 'us-west-2b', 'us-west-2c'],
  otelConfig: otelConfig[environment as keyof typeof otelConfig],
};

// 1. Deploy shared infrastructure first (VPC, subnets, etc.)
const sharedInfraStack = new SharedInfrastructureStack(app, 'ShopSmart-SharedInfra-v2', {
  ...commonProps,
  vpcCidr: '10.0.0.0/16',
});

// 2. Deploy OTel Collector
const otelCollectorStack = new OtelCollectorStack(app, 'ShopSmart-OtelCollector-v2', {
  ...commonProps,
  vpc: sharedInfraStack.vpc,
  privateSubnets: sharedInfraStack.privateAppSubnets,
  publicSubnets: sharedInfraStack.publicSubnets,
});
otelCollectorStack.addDependency(sharedInfraStack);

// 3. Deploy microservices (can be deployed independently after shared infra)
const productCatalogStack = new ProductCatalogStack(app, 'ShopSmart-ProductCatalog-v2', {
  ...commonProps,
  
  // Product Catalog Service - deliberately inefficient sizing
  ec2InstanceType: 'm5.xlarge',
  rdsInstanceType: 'db.r6g.xlarge',
  elasticacheNodeType: 'cache.r6g.large',
  asgMinSize: 3,
  asgMaxSize: 12,
  asgDesiredCapacity: 6,
});

const orderProcessingStack = new OrderProcessingStack(app, 'ShopSmart-OrderProcessing-v2', {
  ...commonProps,
  
  // Order Processing Service - deliberately oversized
  eksNodeInstanceType: 'm5.2xlarge',
  eksMinNodes: 3,
  eksMaxNodes: 9,
  eksDesiredNodes: 3,
  mongodbCpuLimit: '4',
  mongodbMemoryLimit: '8Gi',
  mongodbStorageSize: '500Gi',
});

const userAuthStack = new UserAuthStack(app, 'ShopSmart-UserAuth-v2', {
  ...commonProps,
  
  // User Authentication Service - deliberately inefficient
  dynamodbReadCapacity: 5,
  dynamodbWriteCapacity: 5,
  lambdaLoginMemory: 512,
});

// 3. Deploy API Gateway Router after all microservices
const apiGatewayRouterStack = new ApiGatewayRouterStack(app, 'ShopSmart-ApiGatewayRouter-v2', {
  ...commonProps,
});

// 4. Deploy service integration after all microservices
const serviceIntegrationStack = new ServiceIntegrationStack(app, 'ShopSmart-ServiceIntegration-v2', {
  ...commonProps,
});

// 5. Deploy monitoring stack
const monitoringStack = new MonitoringStack(app, 'ShopSmart-Monitoring-v2', {
  ...commonProps,
  alertEmail: process.env.ALERT_EMAIL, // Optional: set via environment variable
});

// 6. Deploy Frontend stack (CloudFront + S3)
const frontendStack = new FrontendStack(app, 'ShopSmart-Frontend-v2', {
  ...commonProps,
});

// Set up dependencies
productCatalogStack.addDependency(sharedInfraStack);
orderProcessingStack.addDependency(sharedInfraStack);
userAuthStack.addDependency(sharedInfraStack);

// Services that send telemetry must wait for OTel Collector
userAuthStack.addDependency(otelCollectorStack);
productCatalogStack.addDependency(otelCollectorStack);
orderProcessingStack.addDependency(otelCollectorStack);

// API Gateway Router depends on microservices for CloudFormation exports only
// (SSM parameters are resolved at runtime, not deployment time)
apiGatewayRouterStack.addDependency(productCatalogStack);
apiGatewayRouterStack.addDependency(userAuthStack);
// Removed OrderProcessing dependency - uses SSM parameter instead

// Frontend depends on API Gateway Router
frontendStack.addDependency(apiGatewayRouterStack);

// Service Integration depends on microservices for CloudFormation exports only
// (SSM parameters are resolved at runtime, not deployment time)  
serviceIntegrationStack.addDependency(productCatalogStack);
serviceIntegrationStack.addDependency(userAuthStack);
// Removed OrderProcessing dependency - uses SSM parameter instead

// Monitoring depends on all microservices
monitoringStack.addDependency(productCatalogStack);
monitoringStack.addDependency(orderProcessingStack);
monitoringStack.addDependency(userAuthStack);

// Add stack-level tags
const stacks = [
  sharedInfraStack,
  productCatalogStack,
  orderProcessingStack,
  userAuthStack,
  apiGatewayRouterStack,
  frontendStack,
  serviceIntegrationStack,
  monitoringStack
];

stacks.forEach(stack => {
  cdk.Tags.of(stack).add('Application', 'ShopSmart');
  cdk.Tags.of(stack).add('ManagedBy', 'CDK');
  cdk.Tags.of(stack).add('CostCenter', 'Engineering');
  cdk.Tags.of(stack).add('Owner', 'SRE-Team');
});
