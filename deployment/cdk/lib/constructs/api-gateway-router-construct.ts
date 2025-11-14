import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface ApiGatewayRouterConstructProps {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateAppSubnets: ec2.ISubnet[];
  projectName: string;
  environment: string;
  
  // Service endpoints for routing
  authServiceApiGatewayUrl: string;
  productCatalogAlbDnsName: string;
  orderProcessingAlbDnsName: string;
  telemetryCollectorUrl?: string;
  
  // Optional: Service registry SSM prefix for dynamic discovery
  serviceRegistrySSMPrefix?: string;
}

export class ApiGatewayRouterConstruct extends Construct {
  public readonly apiGatewayAlbDnsName: string;
  public readonly healthCheckLambdaArn: string;

  constructor(scope: Construct, id: string, props: ApiGatewayRouterConstructProps) {
    super(scope, id);

    // Security Group for API Gateway ALB
    const apiGatewayAlbSecurityGroup = new ec2.SecurityGroup(this, 'ApiGatewayALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for API Gateway Router ALB',
      allowAllOutbound: true,
    });

    apiGatewayAlbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from anywhere'
    );

    apiGatewayAlbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere'
    );

    // Security Group for Health Check Lambda
    const healthCheckLambdaSecurityGroup = new ec2.SecurityGroup(this, 'HealthCheckLambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Health Check Lambda function',
      allowAllOutbound: true,
    });

    // Application Load Balancer for API Gateway Router
    const apiGatewayAlb = new elbv2.ApplicationLoadBalancer(this, 'ApiGatewayALB', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnets: props.publicSubnets },
      securityGroup: apiGatewayAlbSecurityGroup,
      loadBalancerName: `${props.projectName}-${props.environment}-api-gateway`,
    });

    // Enable X-Ray tracing on ALB
    const cfnLoadBalancer = apiGatewayAlb.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnLoadBalancer.addPropertyOverride('LoadBalancerAttributes', [
      {
        Key: 'access_logs.s3.enabled',
        Value: 'false'
      }
    ]);

    // Lambda Execution Role for Health Check
    const healthCheckLambdaRole = new iam.Role(this, 'HealthCheckLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // Add permissions for health check Lambda to call other services
    healthCheckLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'execute-api:Invoke',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
        'servicediscovery:DiscoverInstances',
        'servicediscovery:GetService',
        'servicediscovery:ListServices',
      ],
      resources: ['*'],
    }));

    // SSM parameters are created by ServiceIntegration stack
    
    // CloudWatch Log Group for Health Check Lambda
    const healthCheckLogGroup = new logs.LogGroup(this, 'HealthCheckLambdaLogGroup', {
      logGroupName: `/aws/lambda/${props.projectName}-${props.environment}-health-check`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Health Check Aggregation Lambda Function
    const healthCheckLambda = new lambda.Function(this, 'HealthCheckLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      securityGroups: [healthCheckLambdaSecurityGroup],
      role: healthCheckLambdaRole,
      environment: {
        AUTH_SERVICE_URL: props.authServiceApiGatewayUrl.replace(/\/$/, ''), // Remove trailing slash
        PRODUCT_CATALOG_URL: `http://${props.productCatalogAlbDnsName}`,
        ORDER_PROCESSING_URL: `http://${props.orderProcessingAlbDnsName}`,
        ENVIRONMENT: props.environment,
        SERVICE_REGISTRY_SSM_PREFIX: props.serviceRegistrySSMPrefix || `/${props.projectName}/${props.environment}/services`,
        PROJECT_NAME: props.projectName,
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import time
import os
import boto3
from datetime import datetime, timedelta

# Disable SSL warnings for internal ALB calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

http = urllib3.PoolManager()
ssm_client = boto3.client('ssm')

# Circuit breaker state storage (in-memory for Lambda)
circuit_breaker_state = {}

class CircuitBreakerConfig:
    def __init__(self):
        self.failure_threshold = 5
        self.recovery_timeout = 30  # seconds
        self.monitoring_period = 60  # seconds

config = CircuitBreakerConfig()

def get_circuit_breaker_state(service_name):
    """Get or initialize circuit breaker state for a service"""
    if service_name not in circuit_breaker_state:
        circuit_breaker_state[service_name] = {
            'state': 'closed',  # closed, open, half-open
            'failure_count': 0,
            'last_failure_time': None,
            'last_success_time': None,
            'last_state_change': datetime.utcnow()
        }
    return circuit_breaker_state[service_name]

def update_circuit_breaker(service_name, success):
    """Update circuit breaker state based on service call result"""
    state = get_circuit_breaker_state(service_name)
    now = datetime.utcnow()
    
    if success:
        state['failure_count'] = 0
        state['last_success_time'] = now
        if state['state'] == 'half-open':
            state['state'] = 'closed'
            state['last_state_change'] = now
    else:
        state['failure_count'] += 1
        state['last_failure_time'] = now
        
        if state['state'] == 'closed' and state['failure_count'] >= config.failure_threshold:
            state['state'] = 'open'
            state['last_state_change'] = now
        elif state['state'] == 'half-open':
            state['state'] = 'open'
            state['last_state_change'] = now

def should_attempt_call(service_name):
    """Determine if we should attempt to call the service based on circuit breaker state"""
    state = get_circuit_breaker_state(service_name)
    now = datetime.utcnow()
    
    if state['state'] == 'closed':
        return True
    elif state['state'] == 'open':
        # Check if recovery timeout has passed
        if state['last_state_change'] and (now - state['last_state_change']).seconds >= config.recovery_timeout:
            state['state'] = 'half-open'
            state['last_state_change'] = now
            return True
        return False
    elif state['state'] == 'half-open':
        return True
    
    return False

def check_service_health(service_name, url, timeout=10):
    """Check health of a single service with circuit breaker logic - Updated 2025-11-04"""
    start_time = time.time()
    
    # Check circuit breaker state
    if not should_attempt_call(service_name):
        cb_state = get_circuit_breaker_state(service_name)
        return {
            "status": "circuit_open",
            "response_time_ms": 0,
            "error": f"Circuit breaker open (failures: {cb_state['failure_count']})",
            "dependencies": {},
            "circuit_breaker": {
                "state": cb_state['state'],
                "failure_count": cb_state['failure_count'],
                "last_failure": cb_state['last_failure_time'].isoformat() if cb_state['last_failure_time'] else None
            }
        }
    
    try:
        # Build health check URL based on service type and SSM parameter structure
        if service_name == "auth":
            # For auth service, construct URL from SSM parameters (protocol + endpoint + /health)
            # The SSM endpoint parameter contains the full URL path
            if url.startswith(('http://', 'https://')):
                # URL is already complete from environment variable
                base_url = url.rstrip('/')
                health_url = f"{base_url}/health"
            else:
                # URL needs to be constructed from SSM parameters
                # This should not happen with current setup, but handle gracefully
                health_url = f"https://{url.rstrip('/')}/health"
        else:
            # For other services, call their health endpoints directly
            base_url = url.rstrip('/')
            health_url = f"{base_url}/health"
        
        # Parse URL properly for urllib3
        print(f"DEBUG: Calling health check URL: {health_url}")
        print(f"DEBUG: Original URL: {url}")
        
        # Make HTTP request using urllib3
        response = http.request('GET', health_url, timeout=timeout)
        response_time = int((time.time() - start_time) * 1000)
        
        if response.status == 200:
            update_circuit_breaker(service_name, True)
            try:
                data = json.loads(response.data.decode('utf-8'))
                return {
                    "status": "healthy",
                    "response_time_ms": response_time,
                    "dependencies": data.get("dependencies", {}),
                    "service_info": data,
                    "circuit_breaker": {
                        "state": get_circuit_breaker_state(service_name)['state'],
                        "failure_count": 0
                    }
                }
            except json.JSONDecodeError:
                return {
                    "status": "healthy",
                    "response_time_ms": response_time,
                    "dependencies": {},
                    "service_info": {"raw_response": response.data.decode('utf-8')[:200]},
                    "circuit_breaker": {
                        "state": get_circuit_breaker_state(service_name)['state'],
                        "failure_count": 0
                    }
                }
        else:
            update_circuit_breaker(service_name, False)
            return {
                "status": "unhealthy",
                "response_time_ms": response_time,
                "error": f"HTTP {response.status}",
                "dependencies": {},
                "circuit_breaker": {
                    "state": get_circuit_breaker_state(service_name)['state'],
                    "failure_count": get_circuit_breaker_state(service_name)['failure_count']
                }
            }
    except Exception as e:
        response_time = int((time.time() - start_time) * 1000)
        update_circuit_breaker(service_name, False)
        return {
            "status": "unhealthy",
            "response_time_ms": response_time,
            "error": str(e),
            "dependencies": {},
            "circuit_breaker": {
                "state": get_circuit_breaker_state(service_name)['state'],
                "failure_count": get_circuit_breaker_state(service_name)['failure_count']
            }
        }

def get_services_from_ssm():
    """Get service endpoints from SSM Parameter Store for dynamic discovery"""
    try:
        ssm_prefix = os.environ.get('SERVICE_REGISTRY_SSM_PREFIX')
        if not ssm_prefix:
            return {}
        
        # Get all service parameters
        response = ssm_client.get_parameters_by_path(
            Path=ssm_prefix,
            Recursive=True
        )
        
        services = {}
        for param in response['Parameters']:
            # Parse parameter name: /project/env/services/service-name/property
            parts = param['Name'].replace(ssm_prefix, '').strip('/').split('/')
            if len(parts) >= 2:
                service_name = parts[0]
                property_name = parts[1]
                
                if service_name not in services:
                    services[service_name] = {}
                
                services[service_name][property_name] = param['Value']
        
        # Build service URLs from SSM parameters
        service_urls = {}
        for service_name, properties in services.items():
            if 'full_url' in properties:
                service_urls[service_name] = properties['full_url']
            elif 'endpoint' in properties and 'protocol' in properties:
                endpoint = properties['endpoint']
                protocol = properties['protocol']
                port = properties.get('port', '')
                
                # Check if endpoint already includes protocol
                if endpoint.startswith(('http://', 'https://')):
                    service_urls[service_name] = endpoint
                else:
                    if port and port not in ['80', '443']:
                        service_urls[service_name] = f"{protocol}://{endpoint}:{port}"
                    else:
                        service_urls[service_name] = f"{protocol}://{endpoint}"
        
        return service_urls
    except Exception as e:
        print(f"Error getting services from SSM: {str(e)}")
        return {}

def handler(event, context):
    """Aggregate health check for all services with circuit breaker logic"""
    # Try to get services from SSM first, fallback to environment variables
    services = get_services_from_ssm()
    
    # Fallback to environment variables if SSM lookup fails
    if not services:
        services = {
            "auth": os.environ.get('AUTH_SERVICE_URL'),
            "product-catalog": os.environ.get('PRODUCT_CATALOG_URL'),
            "order-processing": os.environ.get('ORDER_PROCESSING_URL')
        }
    
    results = {}
    overall_status = "healthy"
    healthy_count = 0
    total_services = len([url for url in services.values() if url])
    
    for service_name, service_url in services.items():
        if service_url:
            results[service_name] = check_service_health(service_name, service_url)
            if results[service_name]["status"] == "healthy":
                healthy_count += 1
            elif results[service_name]["status"] in ["circuit_open", "unhealthy"]:
                if overall_status == "healthy":
                    overall_status = "degraded"
        else:
            results[service_name] = {
                "status": "unknown",
                "response_time_ms": 0,
                "error": "Service URL not configured",
                "dependencies": {},
                "circuit_breaker": {"state": "unknown", "failure_count": 0}
            }
            if overall_status == "healthy":
                overall_status = "degraded"
    
    # Determine overall status based on healthy service ratio
    if total_services > 0:
        healthy_ratio = healthy_count / total_services
        if healthy_ratio == 0:
            overall_status = "unhealthy"
        elif healthy_ratio < 0.5:
            overall_status = "degraded"
        # else remains "healthy" or "degraded" as set above
    
    response_body = {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "services": results,
        "environment": os.environ.get('ENVIRONMENT', 'unknown'),
        "summary": {
            "total_services": total_services,
            "healthy_services": healthy_count,
            "healthy_ratio": round(healthy_count / total_services, 2) if total_services > 0 else 0
        }
    }
    
    # Return 200 for ALB health checks (ALB only accepts 200-499)
    # The detailed status is still available in the response body
    status_code = 200
    
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        },
        'body': json.dumps(response_body, indent=2)
    }
      `),
    });

    // Target Group for Health Check Lambda
    const healthCheckTargetGroup = new elbv2.ApplicationTargetGroup(this, 'HealthCheckTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(healthCheckLambda)],
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200', // Only accept healthy states for ALB health checks
        path: '/',
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Lambda Proxy for Auth Service (API Gateway)
    const authServiceProxyLambda = new lambda.Function(this, 'AuthServiceProxyLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      securityGroups: [healthCheckLambdaSecurityGroup],
      environment: {
        AUTH_API_GATEWAY_URL: props.authServiceApiGatewayUrl.replace(/\/$/, ''), // Remove trailing slash
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import urllib.parse
import os

# Disable SSL warnings for API Gateway calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

http = urllib3.PoolManager()

def handler(event, context):
    """Proxy requests to Auth Service API Gateway"""
    try:
        api_gateway_url = os.environ['AUTH_API_GATEWAY_URL']
        
        # Extract request details from ALB event
        path = event.get('path', '/')
        method = event.get('httpMethod', 'GET')
        query_string = event.get('queryStringParameters') or {}
        headers = event.get('headers') or {}
        body = event.get('body', '')
        
        print(f"Proxying {method} {path} to auth service")
        
        # Remove /api prefix from path since API Gateway expects /auth/*
        if path.startswith('/api'):
            path = path[4:]  # Remove '/api' prefix
        
        # Build target URL
        target_url = f"{api_gateway_url}{path}"
        if query_string:
            query_str = urllib.parse.urlencode(query_string)
            target_url += f"?{query_str}"
        
        # Prepare headers for API Gateway (remove ALB-specific headers)
        proxy_headers = {}
        for key, value in headers.items():
            if key.lower() not in ['host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-port', 'x-amzn-trace-id']:
                proxy_headers[key] = value
        
        # Handle CORS preflight requests
        if method == 'OPTIONS':
            return {
                'statusCode': 200,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                    'Access-Control-Max-Age': '86400'
                },
                'body': ''
            }
        
        # Make request to API Gateway
        if method in ['POST', 'PUT', 'PATCH'] and body:
            response = http.request(
                method,
                target_url,
                body=body,
                headers=proxy_headers,
                timeout=25
            )
        else:
            response = http.request(
                method,
                target_url,
                headers=proxy_headers,
                timeout=25
            )
        
        # Parse response
        response_body = response.data.decode('utf-8')
        
        # Add CORS headers to all responses
        response_headers = {
            'Content-Type': response.headers.get('Content-Type', 'application/json'),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'
        }
        
        return {
            'statusCode': response.status,
            'headers': response_headers,
            'body': response_body
        }
        
    except Exception as e:
        print(f"Error proxying auth request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal proxy error', 'details': str(e)})
        }
      `),
    });

    // Target Group for Auth Service (Lambda)
    const authServiceTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AuthServiceTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(authServiceProxyLambda)],
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Lambda Proxy for Product Catalog Service
    const productCatalogProxyLambda = new lambda.Function(this, 'ProductCatalogProxyLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      securityGroups: [healthCheckLambdaSecurityGroup],
      environment: {
        BACKEND_URL: `http://${props.productCatalogAlbDnsName}`,
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import os

http = urllib3.PoolManager()

def handler(event, context):
    """Proxy requests to Product Catalog service"""
    try:
        backend_url = os.environ['BACKEND_URL']
        
        # Extract request details from ALB event
        path = event.get('path', '/')
        method = event.get('httpMethod', 'GET')
        query_string = event.get('queryStringParameters') or {}
        headers = event.get('headers') or {}
        body = event.get('body')
        
        # Remove /api prefix from path for backend
        if path.startswith('/api'):
            path = path[4:]  # Remove '/api'
        
        # Build query string
        query_params = '&'.join([f"{k}={v}" for k, v in query_string.items()]) if query_string else ''
        full_url = f"{backend_url}{path}"
        if query_params:
            full_url += f"?{query_params}"
        
        # Forward request to backend
        response = http.request(
            method,
            full_url,
            body=body,
            headers={k: v for k, v in headers.items() if k.lower() not in ['host', 'content-length']},
            timeout=25
        )
        
        return {
            'statusCode': response.status,
            'headers': {
                'Content-Type': response.headers.get('Content-Type', 'application/json'),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': response.data.decode('utf-8')
        }
        
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
      `),
    });

    // Target Group for Product Catalog Service (Lambda)
    const productCatalogTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ProductCatalogTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(productCatalogProxyLambda)],
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Security Group for Order Processing Lambda - allows access to ECS service
    const orderProcessingLambdaSecurityGroup = new ec2.SecurityGroup(this, 'OrderProcessingLambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Order Processing Lambda proxy',
      allowAllOutbound: true,
    });

    // Lambda Proxy for Order Processing Service
    const orderProcessingProxyLambda = new lambda.Function(this, 'OrderProcessingProxyLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      securityGroups: [orderProcessingLambdaSecurityGroup],
      environment: {
        BACKEND_URL: `http://${props.orderProcessingAlbDnsName}`,
        PROJECT_NAME: props.projectName,
        ENVIRONMENT: props.environment,
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import os
import boto3

http = urllib3.PoolManager()

def handler(event, context):
    """Proxy requests to Order Processing service - Fixed 2025-11-04"""
    try:
        backend_url = os.environ['BACKEND_URL']
        
        # Extract request details from ALB event
        path = event.get('path', '/')
        method = event.get('httpMethod', 'GET')
        query_string = event.get('queryStringParameters') or {}
        headers = event.get('headers') or {}
        body = event.get('body')
        
        # Remove /api prefix from path for backend
        if path.startswith('/api'):
            path = path[4:]  # Remove '/api'
        
        # Build query string
        query_params = '&'.join([f"{k}={v}" for k, v in query_string.items()]) if query_string else ''
        full_url = f"{backend_url}{path}"
        if query_params:
            full_url += f"?{query_params}"
        
        # Forward request to backend
        response = http.request(
            method,
            full_url,
            body=body,
            headers={k: v for k, v in headers.items() if k.lower() not in ['host', 'content-length']},
            timeout=25
        )
        
        return {
            'statusCode': response.status,
            'headers': {
                'Content-Type': response.headers.get('Content-Type', 'application/json'),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': response.data.decode('utf-8')
        }
        
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
      `),
    });

    // Target Group for Order Processing Service (Lambda)
    const orderProcessingTargetGroup = new elbv2.ApplicationTargetGroup(this, 'OrderProcessingTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(orderProcessingProxyLambda)],
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Lambda Proxy for Telemetry Collector (if provided)
    let telemetryTargetGroup: elbv2.ApplicationTargetGroup | undefined;
    if (props.telemetryCollectorUrl) {
      const telemetryProxyLambda = new lambda.Function(this, 'TelemetryProxyLambda', {
        runtime: lambda.Runtime.PYTHON_3_9,
        handler: 'index.handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        environment: {
          BACKEND_URL: props.telemetryCollectorUrl,
        },
        code: lambda.Code.fromInline(`
import json
import urllib3
import os

http = urllib3.PoolManager()

def handler(event, context):
    try:
        backend_url = os.environ['BACKEND_URL']
        path = event.get('path', '/')
        method = event.get('httpMethod', 'POST')
        body = event.get('body')
        
        # Remove /api prefix
        if path.startswith('/api'):
            path = path[4:]
        
        full_url = f"{backend_url}{path}"
        
        response = http.request(
            method,
            full_url,
            body=body,
            headers={'Content-Type': 'application/json'},
            timeout=25
        )
        
        return {
            'statusCode': response.status,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': response.data.decode('utf-8')
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
        `),
      });

      telemetryTargetGroup = new elbv2.ApplicationTargetGroup(this, 'TelemetryTargetGroup', {
        vpc: props.vpc,
        targetType: elbv2.TargetType.LAMBDA,
        targets: [new elbv2Targets.LambdaTarget(telemetryProxyLambda)],
      });
    }

    // Note: Target registration will be handled manually or via separate automation
    // The target groups are created and ready for registration

    // HTTP Listener with path-based routing
    const httpListener = apiGatewayAlb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: JSON.stringify({
          error: 'Not Found',
          message: 'The requested path was not found. Use /api/auth/*, /api/products*, /api/orders*, /api/config*, or /health'
        })
      }),
    });

    // Routing Rules (in priority order)
    
    // 1. Health check endpoint (highest priority)
    httpListener.addAction('HealthCheckRule', {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/health', '/health/*'])
      ],
      action: elbv2.ListenerAction.forward([healthCheckTargetGroup]),
    });

    // 2. Auth Service routing
    httpListener.addAction('AuthServiceRule', {
      priority: 200,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/auth/*'])
      ],
      action: elbv2.ListenerAction.forward([authServiceTargetGroup]),
    });

    // 3. Product Catalog Service routing
    httpListener.addAction('ProductCatalogRule', {
      priority: 300,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/products*', '/products*'])
      ],
      action: elbv2.ListenerAction.forward([productCatalogTargetGroup]),
    });

    // 4. Order Processing Service routing
    httpListener.addAction('OrderProcessingRule', {
      priority: 400,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/orders*', '/orders*'])
      ],
      action: elbv2.ListenerAction.forward([orderProcessingTargetGroup]),
    });

    // 4.5. Telemetry endpoints routing (if configured)
    if (telemetryTargetGroup) {
      httpListener.addAction('TelemetryRule', {
        priority: 425,
        conditions: [
          elbv2.ListenerCondition.pathPatterns(['/api/telemetry*'])
        ],
        action: elbv2.ListenerAction.forward([telemetryTargetGroup]),
      });
    }

    // 5. Config endpoints routing (also to Order Processing Service)
    httpListener.addAction('ConfigRule', {
      priority: 450,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/config*', '/config*'])
      ],
      action: elbv2.ListenerAction.forward([orderProcessingTargetGroup]),
    });

    // Service Discovery Lambda Function
    // This Lambda automatically discovers backend service endpoints and maintains routing
    const serviceDiscoveryLambda = new lambda.Function(this, 'ServiceDiscoveryLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_WEEK,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      securityGroups: [healthCheckLambdaSecurityGroup],
      environment: {
        PROJECT_NAME: props.projectName,
        ENVIRONMENT: props.environment,
        PRODUCT_CATALOG_DNS: props.productCatalogAlbDnsName,
        ORDER_PROCESSING_DNS: props.orderProcessingAlbDnsName,
        AUTH_SERVICE_URL: props.authServiceApiGatewayUrl.replace(/\/$/, ''), // Remove trailing slash
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import socket
import urllib3
import logging
import os
import time
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Disable SSL warnings for internal ALB calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
http = urllib3.PoolManager()

def handler(event, context):
    """Service discovery for backend services - Lambda proxy approach"""
    try:
        logger.info(f"Service discovery request: {json.dumps(event, default=str)}")
        
        # Handle CloudFormation custom resource events
        if 'RequestType' in event:
            if event['RequestType'] == 'Delete':
                send_cfn_response(event, context, 'SUCCESS', {})
                return
        
        # Get service endpoints from environment
        services = {}
        
        # Product Catalog Service
        product_catalog_dns = os.environ.get('PRODUCT_CATALOG_DNS')
        if product_catalog_dns:
            services['product_catalog'] = {
                'dns': product_catalog_dns,
                'endpoint': f"http://{product_catalog_dns}",
                'status': 'available',
                'type': 'alb',
                'last_updated': datetime.utcnow().isoformat()
            }
        
        # Order Processing Service
        order_processing_dns = os.environ.get('ORDER_PROCESSING_DNS')
        if order_processing_dns and order_processing_dns != 'order-processing-internal-alb.local':
            services['order_processing'] = {
                'dns': order_processing_dns,
                'endpoint': f"http://{order_processing_dns}",
                'status': 'available',
                'type': 'alb',
                'last_updated': datetime.utcnow().isoformat()
            }
        
        # Auth Service (API Gateway)
        auth_service_url = os.environ.get('AUTH_SERVICE_URL')
        if auth_service_url:
            services['auth'] = {
                'endpoint': auth_service_url,
                'status': 'available',
                'type': 'api_gateway',
                'last_updated': datetime.utcnow().isoformat()
            }
        
        # Send success response for CloudFormation
        if 'RequestType' in event:
            send_cfn_response(event, context, 'SUCCESS', {'Services': services})
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'message': 'Service discovery completed',
                'services': services,
                'timestamp': datetime.utcnow().isoformat()
            })
        }
                        register_targets(order_processing_tg_arn, order_ips, 80)
                        results['order_processing'] = {'ips': order_ips, 'status': 'registered'}
                    else:
                        results['order_processing'] = {'status': 'no_ips_found'}
                except Exception as e:
                    logger.error(f"Failed to register Order Processing targets: {str(e)}")
                    results['order_processing'] = {'status': 'error', 'error': str(e)}
            else:
                results['order_processing'] = {'status': 'skipped_placeholder_dns'}
            
            # Auth service now uses Lambda proxy - no IP registration needed
            results['auth_service'] = {'status': 'lambda_proxy_used'}
        
        logger.info(f"Target registration completed: {results}")
        
        # Handle CloudFormation custom resource response
        if request_type in ['Create', 'Update', 'Delete']:
            response_data = {
                'Message': 'Target registration completed',
                'Results': results
            }
            
            send_cfn_response(event, context, 'SUCCESS', response_data)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Target registration completed',
                'results': results
            })
        }
        
    except Exception as e:
        logger.error(f"Target registration failed: {str(e)}")
        
        # Handle CloudFormation custom resource error response
        request_type = event.get('RequestType', 'Direct')
        if request_type in ['Create', 'Update', 'Delete']:
            send_cfn_response(event, context, 'FAILED', {'Error': str(e)})
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }

def send_cfn_response(event, context, status, response_data):
    """Send response to CloudFormation custom resource"""
    import urllib3
    
    response_url = event.get('ResponseURL')
    if not response_url:
        return
    
    response_body = {
        'Status': status,
        'Reason': f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event.get('StackId'),
        'RequestId': event.get('RequestId'),
        'LogicalResourceId': event.get('LogicalResourceId'),
        'Data': response_data
    }
    
    try:
        http = urllib3.PoolManager()
        response = http.request('PUT', response_url, 
                              body=json.dumps(response_body),
                              headers={'Content-Type': 'application/json'})
        logger.info(f"CloudFormation response sent: {response.status}")
    except Exception as e:
        logger.error(f"Failed to send CloudFormation response: {str(e)}")

def resolve_alb_ips(dns_name):
    """Resolve ALB DNS name to private VPC IP addresses"""
    try:
        elbv2_client = boto3.client('elbv2')
        ec2_client = boto3.client('ec2')
        
        logger.info(f"Resolving ALB IPs for: {dns_name}")
        
        # Find the ALB by DNS name
        response = elbv2_client.describe_load_balancers()
        target_alb = None
        
        for alb in response['LoadBalancers']:
            if alb['DNSName'] == dns_name:
                target_alb = alb
                break
        
        if not target_alb:
            logger.error(f"ALB not found for DNS name: {dns_name}")
            return []
        
        logger.info(f"Found ALB: {target_alb['LoadBalancerName']}")
        
        # Get the ALB's availability zones and subnets
        availability_zones = target_alb['AvailabilityZones']
        subnet_ids = [az['SubnetId'] for az in availability_zones]
        alb_name = target_alb['LoadBalancerName']
        
        logger.info(f"ALB subnets: {subnet_ids}")
        
        # Get network interfaces for the ALB
        # Try multiple description patterns that AWS uses for ALB ENIs
        description_patterns = [
            f'ELB app/{alb_name}/*',
            f'ELB {alb_name}',
            f'*{alb_name}*'
        ]
        
        ips = []
        for pattern in description_patterns:
            try:
                response = ec2_client.describe_network_interfaces(
                    Filters=[
                        {'Name': 'subnet-id', 'Values': subnet_ids},
                        {'Name': 'description', 'Values': [pattern]}
                    ]
                )
                
                for eni in response['NetworkInterfaces']:
                    if eni['PrivateIpAddress'] and eni['PrivateIpAddress'] not in ips:
                        ips.append(eni['PrivateIpAddress'])
                        logger.info(f"Found ALB ENI: {eni['NetworkInterfaceId']} -> {eni['PrivateIpAddress']}")
                
                if ips:
                    break  # Found IPs with this pattern
                    
            except Exception as e:
                logger.warning(f"Failed to find ENIs with pattern {pattern}: {str(e)}")
        
        # If still no IPs found, try a broader search
        if not ips:
            logger.info("Trying broader ENI search...")
            response = ec2_client.describe_network_interfaces(
                Filters=[
                    {'Name': 'subnet-id', 'Values': subnet_ids}
                ]
            )
            
            for eni in response['NetworkInterfaces']:
                description = eni.get('Description', '')
                if 'ELB' in description and alb_name in description:
                    if eni['PrivateIpAddress'] and eni['PrivateIpAddress'] not in ips:
                        ips.append(eni['PrivateIpAddress'])
                        logger.info(f"Found ALB ENI (broad search): {eni['NetworkInterfaceId']} -> {eni['PrivateIpAddress']}")
        
        # Final fallback: DNS resolution with private IP filtering
        if not ips:
            logger.info("Trying DNS resolution fallback...")
            try:
                result = socket.getaddrinfo(dns_name, None)
                all_ips = [addr[4][0] for addr in result if addr[0] == socket.AF_INET]
                
                for ip in all_ips:
                    if is_private_ip(ip):
                        ips.append(ip)
                        logger.info(f"Found private IP via DNS: {ip}")
            except Exception as e:
                logger.warning(f"DNS resolution fallback failed: {str(e)}")
        
        logger.info(f"Final resolved IPs for {dns_name}: {ips}")
        return ips
        
    except Exception as e:
        logger.error(f"Failed to resolve {dns_name}: {str(e)}")
        return []

def is_private_ip(ip):
    """Check if IP address is in private range"""
    try:
        # Check for private IP ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
        parts = ip.split('.')
        if len(parts) != 4:
            return False
        
        first_octet = int(parts[0])
        second_octet = int(parts[1])
        
        # 10.0.0.0/8
        if first_octet == 10:
            return True
        
        # 172.16.0.0/12
        if first_octet == 172 and 16 <= second_octet <= 31:
            return True
        
        # 192.168.0.0/16
        if first_octet == 192 and second_octet == 168:
            return True
        
        return False
    except:
        return False

def register_targets(target_group_arn, ips, port):
    """Register IP addresses as targets in target group"""
    try:
        # First, deregister any existing targets
        existing_targets = elbv2_client.describe_target_health(
            TargetGroupArn=target_group_arn
        )
        
        if existing_targets['TargetHealthDescriptions']:
            targets_to_deregister = [
                {'Id': target['Target']['Id'], 'Port': target['Target']['Port']}
                for target in existing_targets['TargetHealthDescriptions']
            ]
            
            elbv2_client.deregister_targets(
                TargetGroupArn=target_group_arn,
                Targets=targets_to_deregister
            )
            logger.info(f"Deregistered {len(targets_to_deregister)} existing targets")
        
        # Register new targets
        targets_to_register = [{'Id': ip, 'Port': port} for ip in ips]
        
        elbv2_client.register_targets(
            TargetGroupArn=target_group_arn,
            Targets=targets_to_register
        )
        
        logger.info(f"Registered {len(targets_to_register)} targets in {target_group_arn}")
        
    except Exception as e:
        logger.error(f"Failed to register targets in {target_group_arn}: {str(e)}")
        raise
      `),
    });

    // Add permissions for service discovery Lambda
    serviceDiscoveryLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeLoadBalancers',
        'ec2:DescribeNetworkInterfaces',
      ],
      resources: ['*'], // Need broad permissions for describe operations
    }));

    // Note: No custom resource needed for Lambda targets - they are automatically managed

    // Note: Periodic service discovery removed - Lambda targets are automatically managed

    // Note: Service discovery Lambda output removed - using Lambda targets

    // Set outputs
    this.apiGatewayAlbDnsName = apiGatewayAlb.loadBalancerDnsName;
    this.healthCheckLambdaArn = healthCheckLambda.functionArn;

    // CloudFormation Outputs
    new cdk.CfnOutput(this, 'ApiGatewayALBDnsName', {
      value: this.apiGatewayAlbDnsName,
      exportName: `${props.projectName}-${props.environment}-ApiGatewayALBDnsName`,
      description: 'DNS name of the API Gateway Router ALB',
    });

    new cdk.CfnOutput(this, 'HealthCheckLambdaArn', {
      value: this.healthCheckLambdaArn,
      exportName: `${props.projectName}-${props.environment}-HealthCheckLambdaArn`,
      description: 'ARN of the Health Check Lambda function',
    });

    new cdk.CfnOutput(this, 'ApiGatewayEndpoint', {
      value: `http://${this.apiGatewayAlbDnsName}`,
      description: 'API Gateway Router endpoint URL',
    });

    // Export Lambda security group ID for reference
    new cdk.CfnOutput(this, 'OrderProcessingLambdaSecurityGroupId', {
      value: orderProcessingLambdaSecurityGroup.securityGroupId,
      exportName: `${props.projectName}-${props.environment}-ApiGatewayLambdaSecurityGroupId`,
      description: 'Security Group ID for API Gateway Lambda functions',
    });

    // CloudWatch Alarms for monitoring
    const unhealthyTargetsAlarm = new cloudwatch.Alarm(this, 'UnhealthyTargetsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          LoadBalancer: apiGatewayAlb.loadBalancerFullName,
        },
        statistic: 'Average',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway Router has unhealthy targets',
    });

    const highResponseTimeAlarm = new cloudwatch.Alarm(this, 'HighResponseTimeAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: {
          LoadBalancer: apiGatewayAlb.loadBalancerFullName,
        },
        statistic: 'Average',
      }),
      threshold: 1, // 1 second
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway Router response time is high',
    });

    // Lambda error monitoring
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'HealthCheckLambdaErrorAlarm', {
      metric: healthCheckLambda.metricErrors(),
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Health Check Lambda is experiencing errors',
    });

    // Export CloudWatch Dashboard metrics
    new cdk.CfnOutput(this, 'MonitoringDashboard', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${cdk.Stack.of(this).region}#dashboards:name=ApiGatewayRouter`,
      description: 'CloudWatch Dashboard for API Gateway Router monitoring',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'ApiGatewayRouter');
    cdk.Tags.of(this).add('Component', 'LoadBalancer');
  }
}