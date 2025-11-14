import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export interface FrontendRoutingConstructProps {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateAppSubnets: ec2.ISubnet[];
  projectName: string;
  environment: string;
  ec2InstanceType: string;
  asgMinSize: number;
  asgMaxSize: number;
  asgDesiredCapacity: number;
  productCatalogAlbDnsName: string;
  userAuthApiUrl: string;
  orderProcessingAlbDnsName: string;
  // New API Gateway Router endpoint
  apiGatewayRouterAlbDnsName?: string;
}

export class FrontendRoutingConstruct extends Construct {
  public readonly albDnsName: string;
  public readonly cloudfrontDomainName: string;

  constructor(scope: Construct, id: string, props: FrontendRoutingConstructProps) {
    super(scope, id);

    // Security Groups
    const albSecurityGroup = new ec2.SecurityGroup(this, 'FrontendALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Frontend ALB',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic'
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic'
    );

    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'FrontendEC2SecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Frontend EC2 instances',
      allowAllOutbound: true,
    });

    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      'Allow traffic from ALB'
    );

    // S3 Bucket for Frontend Assets
    const frontendAssetsBucket = new s3.Bucket(this, 'FrontendAssetsBucket', {
      bucketName: `${props.projectName}-${props.environment}-frontend-assets`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes
      autoDeleteObjects: true, // For demo purposes
    });

    // Deploy frontend assets to S3
    // Note: Configuration injection will be handled by a separate build process
    new s3deploy.BucketDeployment(this, 'FrontendAssetDeployment', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../../../src/frontend'), {
          exclude: ['build.sh', '*.md']
        })
      ],
      destinationBucket: frontendAssetsBucket,
      retainOnDelete: false,
    });

    // IAM Role for EC2 instances
    const ec2Role = new iam.Role(this, 'FrontendEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // S3 access policy for frontend assets
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        frontendAssetsBucket.bucketArn,
        `${frontendAssetsBucket.bucketArn}/*`,
      ],
    }));

    // CloudWatch Logs policy
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: ['*'],
    }));

    // SSM Parameter access for configuration
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath'
      ],
      resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${props.projectName}/${props.environment}/frontend/*`],
    }));

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'FrontendALB', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: {
        subnets: props.publicSubnets,
      },
      securityGroup: albSecurityGroup,
      loadBalancerName: `${props.projectName}-${props.environment}-frontend`,
    });

    // Target Group for Storefront
    const storefrontTargetGroup = new elbv2.ApplicationTargetGroup(this, 'StorefrontTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetGroupName: `${props.projectName}-${props.environment}-store`,
      healthCheck: {
        path: '/health',
        port: '80',
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Target Group for Platform Dashboard
    const platformTargetGroup = new elbv2.ApplicationTargetGroup(this, 'PlatformTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetGroupName: `${props.projectName}-${props.environment}-plat`,
      healthCheck: {
        path: '/platform/health',
        port: '80',
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Launch Template with dual frontend configuration
    const userData = ec2.UserData.forLinux({
      shebang: '#!/bin/bash',
    });

    userData.addCommands(
      'echo "Installing CloudWatch agent and web server"',
      'yum update -y',
      'yum install -y amazon-cloudwatch-agent',
      'amazon-linux-extras install -y nginx1',
      '',
      '# Configure nginx for dual frontend routing',
      'cat > /etc/nginx/nginx.conf << "EOF"',
      'user nginx;',
      'worker_processes auto;',
      'error_log /var/log/nginx/error.log;',
      'pid /run/nginx.pid;',
      '',
      'events {',
      '    worker_connections 1024;',
      '}',
      '',
      'http {',
      '    log_format main \'$remote_addr - $remote_user [$time_local] "$request" \'',
      '                    \'$status $body_bytes_sent "$http_referer" \'',
      '                    \'"$http_user_agent" "$http_x_forwarded_for"\';',
      '',
      '    access_log /var/log/nginx/access.log main;',
      '',
      '    sendfile on;',
      '    tcp_nopush on;',
      '    tcp_nodelay on;',
      '    keepalive_timeout 65;',
      '    types_hash_max_size 2048;',
      '',
      '    include /etc/nginx/mime.types;',
      '    default_type application/octet-stream;',
      '',
      '    server {',
      '        listen 80 default_server;',
      '        server_name _;',
      '        root /var/www/html;',
      '',
      '        # Health check endpoint',
      '        location /health {',
      '            access_log off;',
      '            return 200 "OK\\n";',
      '            add_header Content-Type text/plain;',
      '        }',
      '',
      '        # Platform dashboard routing',
      '        location /platform {',
      '            try_files $uri /platform/index.html;',
      '        }',
      '',
      '        # Platform health check',
      '        location /platform/health {',
      '            access_log off;',
      '            return 200 "Platform OK\\n";',
      '            add_header Content-Type text/plain;',
      '        }',
      '',
      '        # API proxy routes - Route all /api/* to unified API Gateway Router',
      ...(props.apiGatewayRouterAlbDnsName ? [
        '        location /api/ {',
        `            proxy_pass http://${props.apiGatewayRouterAlbDnsName}/api/;`,
        '            proxy_set_header Host $host;',
        '            proxy_set_header X-Real-IP $remote_addr;',
        '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '            proxy_set_header X-Forwarded-Proto $scheme;',
        '        }',
      ] : [
        '        # Fallback API proxy routes (when API Gateway Router not available)',
        '        location /api/products/ {',
        `            proxy_pass http://${props.productCatalogAlbDnsName}/;`,
        '            proxy_set_header Host $host;',
        '            proxy_set_header X-Real-IP $remote_addr;',
        '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '            proxy_set_header X-Forwarded-Proto $scheme;',
        '        }',
        '',
        '        location /api/auth/ {',
        `            proxy_pass ${props.userAuthApiUrl};`,
        '            proxy_set_header Host $host;',
        '            proxy_set_header X-Real-IP $remote_addr;',
        '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '            proxy_set_header X-Forwarded-Proto $scheme;',
        '        }',
        '',
        '        location /api/orders/ {',
        `            proxy_pass http://${props.orderProcessingAlbDnsName}/;`,
        '            proxy_set_header Host $host;',
        '            proxy_set_header X-Real-IP $remote_addr;',
        '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '            proxy_set_header X-Forwarded-Proto $scheme;',
        '        }',
      ]),
      '',
      '        # Default route to storefront',
      '        location / {',
      '            try_files $uri /storefront.html;',
      '        }',
      '',
      '        # Security headers',
      '        add_header X-Frame-Options "SAMEORIGIN" always;',
      '        add_header X-XSS-Protection "1; mode=block" always;',
      '        add_header X-Content-Type-Options "nosniff" always;',
      '        add_header Referrer-Policy "no-referrer-when-downgrade" always;',
      '        add_header Content-Security-Policy "default-src \'self\' http: https: data: blob: \'unsafe-inline\'" always;',
      '    }',
      '}',
      'EOF',
      '',
      '# Create web directory structure',
      'mkdir -p /var/www/html/platform',
      'mkdir -p /var/www/html/css',
      'mkdir -p /var/www/html/js',
      '',
      '# Download and deploy frontend assets from S3',
      `aws s3 sync s3://${frontendAssetsBucket.bucketName}/ /var/www/html/ --delete || echo "S3 sync failed, using placeholder files"`,
      '',
      '# Create placeholder files if S3 sync failed',
      'if [ ! -f /var/www/html/storefront.html ]; then',
      '    echo "Artisan Desk Storefront Loading..." > /var/www/html/storefront.html',
      'fi',
      'if [ ! -f /var/www/html/platform/index.html ]; then',
      '    echo "Platform Dashboard Loading..." > /var/www/html/platform/index.html',
      'fi',
      'if [ ! -f /var/www/html/health ]; then',
      '    echo "OK" > /var/www/html/health',
      'fi',
      '',
      '# Set proper permissions',
      'chown -R nginx:nginx /var/www/html',
      'chmod -R 755 /var/www/html',
      '',
      '# Test nginx configuration',
      'echo "Testing nginx configuration..."',
      'nginx -t 2>&1 | tee /tmp/nginx-test.log',
      'if [ $? -ne 0 ]; then',
      '    echo "Nginx configuration test failed!"',
      '    cat /etc/nginx/nginx.conf',
      '    exit 1',
      'fi',
      '',
      '# Start services',
      'systemctl enable nginx',
      'systemctl start nginx',
      '',
      '# Configure CloudWatch agent',
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOF',
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/nginx/access.log",',
      '            "log_group_name": "/aws/ec2/frontend/nginx/access",',
      '            "log_stream_name": "{instance_id}"',
      '          },',
      '          {',
      '            "file_path": "/var/log/nginx/error.log",',
      '            "log_group_name": "/aws/ec2/frontend/nginx/error",',
      '            "log_stream_name": "{instance_id}"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'EOF',
      '',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s'
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'FrontendLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.ec2InstanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      role: ec2Role,
      securityGroup: ec2SecurityGroup,
      userData: userData,
    });

    // Auto Scaling Group
    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'FrontendAutoScalingGroup', {
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      launchTemplate: launchTemplate,
      minCapacity: props.asgMinSize,
      maxCapacity: props.asgMaxSize,
      desiredCapacity: props.asgDesiredCapacity,
      healthCheck: autoscaling.HealthCheck.elb({
        grace: cdk.Duration.seconds(300),
      }),
    });

    // Attach ASG to Target Groups
    autoScalingGroup.attachToApplicationTargetGroup(storefrontTargetGroup);
    autoScalingGroup.attachToApplicationTargetGroup(platformTargetGroup);

    // HTTP Listener with path-based routing
    const httpListener = alb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([storefrontTargetGroup]), // Default to storefront
    });

    // Add listener rules for path-based routing
    httpListener.addAction('PlatformRouting', {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/platform*']),
      ],
      action: elbv2.ListenerAction.forward([platformTargetGroup]),
    });

    // HTTPS Listener (commented out - requires certificate)
    // const httpsListener = alb.addListener('HTTPSListener', {
    //   port: 443,
    //   protocol: elbv2.ApplicationProtocol.HTTPS,
    //   certificates: [certificate],
    //   defaultAction: elbv2.ListenerAction.forward([storefrontTargetGroup]),
    // });

    // httpsListener.addAction('PlatformRoutingHTTPS', {
    //   priority: 100,
    //   conditions: [
    //     elbv2.ListenerCondition.pathPatterns(['/platform*']),
    //   ],
    //   action: elbv2.ListenerAction.forward([platformTargetGroup]),
    // });

    // Create origins for different services
    const frontendAlbOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    // API Gateway Router origin (if provided, otherwise fallback to frontend ALB)
    const apiGatewayOrigin = props.apiGatewayRouterAlbDnsName 
      ? new origins.HttpOrigin(props.apiGatewayRouterAlbDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        })
      : frontendAlbOrigin;

    // S3 origin for static assets
    const s3AssetsOrigin = new origins.S3Origin(frontendAssetsBucket);

    // CloudFront Distribution for global content delivery
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: frontendAlbOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
      },
      additionalBehaviors: {
        // API routes go to API Gateway Router (highest priority)
        '/api/*': {
          origin: apiGatewayOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // No caching for API calls
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          compress: false, // Disable compression for API responses
        },
        // Health check endpoint goes to API Gateway Router
        '/health': {
          origin: apiGatewayOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // No caching for health checks
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        // Platform dashboard routes to frontend ALB
        '/platform/*': {
          origin: frontendAlbOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // No caching for platform dashboard
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        // Static CSS assets from S3
        '/css/*': {
          origin: s3AssetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        // Static JS assets from S3
        '/js/*': {
          origin: s3AssetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Use only North America and Europe
      enabled: true,
      comment: `${props.projectName} ${props.environment} Frontend Distribution with API Gateway Router`,
    });

    // Set outputs
    this.albDnsName = alb.loadBalancerDnsName;
    this.cloudfrontDomainName = distribution.distributionDomainName;

    // SSM Parameters for frontend configuration
    new cdk.aws_ssm.StringParameter(this, 'StorefrontEnabledParam', {
      parameterName: `/${props.projectName}/${props.environment}/frontend/storefront-enabled`,
      stringValue: 'true',
      description: 'Enable artisan desk storefront as default frontend',
    });

    new cdk.aws_ssm.StringParameter(this, 'PlatformRoutingEnabledParam', {
      parameterName: `/${props.projectName}/${props.environment}/frontend/platform-routing-enabled`,
      stringValue: 'true',
      description: 'Enable platform dashboard routing at /platform',
    });

    new cdk.aws_ssm.StringParameter(this, 'ApiProxyEnabledParam', {
      parameterName: `/${props.projectName}/${props.environment}/frontend/api-proxy-enabled`,
      stringValue: 'true',
      description: 'Enable API proxy routing for microservices',
    });

    // CloudWatch Log Groups
    const nginxAccessLogGroup = new logs.LogGroup(this, 'NginxAccessLogGroup', {
      logGroupName: '/aws/ec2/frontend/nginx/access',
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const nginxErrorLogGroup = new logs.LogGroup(this, 'NginxErrorLogGroup', {
      logGroupName: '/aws/ec2/frontend/nginx/error',
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // CloudWatch Alarms
    // ALB Target Health
    new cloudwatch.Alarm(this, 'StorefrontUnhealthyTargets', {
      alarmName: `${props.projectName}-${props.environment}-storefront-unhealthy-targets`,
      metric: storefrontTargetGroup.metricUnhealthyHostCount(),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: 'Storefront has unhealthy targets',
    });

    new cloudwatch.Alarm(this, 'PlatformUnhealthyTargets', {
      alarmName: `${props.projectName}-${props.environment}-platform-unhealthy-targets`,
      metric: platformTargetGroup.metricUnhealthyHostCount(),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: 'Platform dashboard has unhealthy targets',
    });

    // ALB Response Time
    new cloudwatch.Alarm(this, 'FrontendHighResponseTime', {
      alarmName: `${props.projectName}-${props.environment}-frontend-high-response-time`,
      metric: storefrontTargetGroup.metricTargetResponseTime(),
      threshold: 2,
      evaluationPeriods: 3,
      alarmDescription: 'Frontend response time is high',
    });

    // CloudFront Error Rate
    new cloudwatch.Alarm(this, 'CloudFrontHighErrorRate', {
      alarmName: `${props.projectName}-${props.environment}-cloudfront-high-error-rate`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: '4xxErrorRate',
        dimensionsMap: {
          DistributionId: distribution.distributionId,
        },
      }),
      threshold: 5,
      evaluationPeriods: 2,
      alarmDescription: 'CloudFront 4xx error rate is high',
    });

    // Auto Scaling Group Metrics
    new cloudwatch.Alarm(this, 'FrontendASGHighCPU', {
      alarmName: `${props.projectName}-${props.environment}-frontend-asg-high-cpu`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          AutoScalingGroupName: autoScalingGroup.autoScalingGroupName,
        },
      }),
      threshold: 75,
      evaluationPeriods: 2,
      alarmDescription: 'Frontend ASG CPU utilization is high',
    });

    // Custom Metrics Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'FrontendDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-frontend`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'ALB Metrics',
            left: [
              storefrontTargetGroup.metricRequestCount(),
              platformTargetGroup.metricRequestCount(),
            ],
            right: [
              storefrontTargetGroup.metricTargetResponseTime(),
              platformTargetGroup.metricTargetResponseTime(),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Target Health',
            left: [
              storefrontTargetGroup.metricHealthyHostCount(),
              platformTargetGroup.metricHealthyHostCount(),
            ],
            right: [
              storefrontTargetGroup.metricUnhealthyHostCount(),
              platformTargetGroup.metricUnhealthyHostCount(),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'CloudFront Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'Requests',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: '4xxErrorRate',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: '5xxErrorRate',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
              }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Auto Scaling Group',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/EC2',
                metricName: 'CPUUtilization',
                dimensionsMap: {
                  AutoScalingGroupName: autoScalingGroup.autoScalingGroupName,
                },
              }),
            ],
            width: 12,
          }),
        ],
      ],
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'Frontend');
  }
}