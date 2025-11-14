import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiGatewayRouterStack } from '../lib/api-gateway-router-stack';

describe('ApiGatewayRouterStack', () => {
  test('creates API Gateway Router with proper routing rules', () => {
    const app = new cdk.App();
    
    // Mock the required environment variables and imports
    const stack = new ApiGatewayRouterStack(app, 'TestApiGatewayRouterStack', {
      projectName: 'test-project',
      environment: 'test',
      availabilityZones: ['us-west-2a', 'us-west-2b'],
      env: { account: '123456789012', region: 'us-west-2' },
    });

    const template = Template.fromStack(stack);

    // Verify ALB is created
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'application',
      Scheme: 'internet-facing',
    });

    // Verify health check Lambda is created
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.9',
      Handler: 'index.handler',
    });

    // Verify target groups are created
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 4); // Health, Auth, Product, Order

    // Verify listener rules are created
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 100, // Health check rule
      Conditions: [
        {
          Field: 'path-pattern',
          Values: ['/health', '/health/*'],
        },
      ],
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 200, // Auth service rule
      Conditions: [
        {
          Field: 'path-pattern',
          Values: ['/api/auth/*'],
        },
      ],
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 300, // Product catalog rule
      Conditions: [
        {
          Field: 'path-pattern',
          Values: ['/api/products*', '/products*'],
        },
      ],
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 400, // Order processing rule
      Conditions: [
        {
          Field: 'path-pattern',
          Values: ['/api/orders*', '/orders*'],
        },
      ],
    });
  });

  test('creates proper security groups', () => {
    const app = new cdk.App();
    
    const stack = new ApiGatewayRouterStack(app, 'TestApiGatewayRouterStack', {
      projectName: 'test-project',
      environment: 'test',
      availabilityZones: ['us-west-2a', 'us-west-2b'],
      env: { account: '123456789012', region: 'us-west-2' },
    });

    const template = Template.fromStack(stack);

    // Verify security groups are created
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for API Gateway Router ALB',
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0',
        },
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
        },
      ],
    });

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Health Check Lambda function',
    });
  });

  test('exports proper CloudFormation outputs', () => {
    const app = new cdk.App();
    
    const stack = new ApiGatewayRouterStack(app, 'TestApiGatewayRouterStack', {
      projectName: 'test-project',
      environment: 'test',
      availabilityZones: ['us-west-2a', 'us-west-2b'],
      env: { account: '123456789012', region: 'us-west-2' },
    });

    const template = Template.fromStack(stack);

    // Verify CloudFormation outputs
    template.hasOutput('ApiGatewayRouterALBDnsName', {
      Export: {
        Name: 'test-project-test-ApiGatewayRouterALBDnsName',
      },
    });

    template.hasOutput('ApiGatewayRouterHealthCheckLambdaArn', {
      Export: {
        Name: 'test-project-test-ApiGatewayRouterHealthCheckLambdaArn',
      },
    });

    template.hasOutput('ApiGatewayRouterEndpoint', {});
  });
});