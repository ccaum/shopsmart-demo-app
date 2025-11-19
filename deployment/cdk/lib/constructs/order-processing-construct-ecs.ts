import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as applicationautoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as xray from 'aws-cdk-lib/aws-xray';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatchactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export interface OrderProcessingEcsConstructProps {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateAppSubnets: ec2.ISubnet[];
  availabilityZones: string[];
  projectName: string;
  environment: string;
  ecsInstanceType: string;
  ecsMinCapacity: number;
  ecsMaxCapacity: number;
  ecsDesiredCapacity: number;
  mongodbCpuLimit: number;
  mongodbMemoryLimit: number;
  mongodbStorageSize: string;
}

export class OrderProcessingEcsConstruct extends Construct {
  public readonly clusterName: string;
  public readonly serviceArn: string;
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: OrderProcessingEcsConstructProps) {
    super(scope, id);

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, 'ECSCluster', {
      clusterName: `${props.projectName}-${props.environment}-order-processing`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // Add EC2 capacity to the cluster (deliberately oversized)
    const autoScalingGroup = cluster.addCapacity('DefaultAutoScalingGroup', {
      instanceType: new ec2.InstanceType(props.ecsInstanceType),
      minCapacity: props.ecsMinCapacity,
      maxCapacity: props.ecsMaxCapacity,
      desiredCapacity: props.ecsDesiredCapacity,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
    });

    // Security Group for MongoDB
    const mongodbSecurityGroup = new ec2.SecurityGroup(this, 'MongoDBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for MongoDB container',
      allowAllOutbound: true,
    });

    // Security Group for Order Processing App
    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Order Processing application',
      allowAllOutbound: true,
    });

    // Allow app to connect to MongoDB
    mongodbSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(27017),
      'Allow Order Processing app to connect to MongoDB'
    );

    // Application Load Balancer Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from VPC (API Gateway Router)'
    );

    // Allow ALB to connect to app
    appSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      'Allow ALB to connect to Order Processing app'
    );

    // Allow ALB to connect to app on port 8000 (application port)
    appSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(8000),
      'Load balancer to target'
    );

    // Allow any Lambda in the VPC to connect on port 8000 (for API Gateway proxies)
    appSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      'Allow Lambda functions to connect to Order Processing app'
    );

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task Role with enhanced permissions for luxury orders and observability
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add permissions for luxury order processing
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sns:Publish',
        'events:PutEvents',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath'
      ],
      resources: ['*'],
    }));

    // Enhanced CloudWatch permissions for comprehensive observability
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
        'logs:DescribeLogGroups'
      ],
      resources: ['*'],
    }));

    // X-Ray tracing permissions
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
        'xray:GetSamplingStatisticSummaries'
      ],
      resources: ['*'],
    }));

    // Service discovery permissions for service mesh
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'servicediscovery:RegisterInstance',
        'servicediscovery:DeregisterInstance',
        'servicediscovery:DiscoverInstances',
        'servicediscovery:GetInstancesHealthStatus'
      ],
      resources: ['*'],
    }));

    // CloudWatch Log Groups with proper retention and structure
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${props.projectName}-${props.environment}-order-processing`,
      retention: logs.RetentionDays.ONE_MONTH, // Extended retention for better observability
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Separate log group for application metrics and traces
    const metricsLogGroup = new logs.LogGroup(this, 'MetricsLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-order-processing/metrics`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for X-Ray traces
    const tracingLogGroup = new logs.LogGroup(this, 'TracingLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-order-processing/traces`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SNS Topic for CloudWatch Alarms
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${props.projectName}-${props.environment}-order-processing-alerts`,
      displayName: 'Order Processing Service Alerts',
    });

    // MongoDB Task Definition
    const mongodbTaskDefinition = new ecs.Ec2TaskDefinition(this, 'MongoDBTaskDefinition', {
      executionRole: taskExecutionRole,
      taskRole: taskRole,
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    const mongodbContainer = mongodbTaskDefinition.addContainer('mongodb', {
      image: ecs.ContainerImage.fromRegistry('mongo:6.0'),
      cpu: props.mongodbCpuLimit, // Deliberately oversized
      memoryLimitMiB: props.mongodbMemoryLimit, // Deliberately oversized
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'admin',
        MONGO_INITDB_ROOT_PASSWORD: 'Password123!', // In production, use secrets
        MONGO_INITDB_DATABASE: 'luxury_orders',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mongodb',
        logGroup: logGroup,
      }),
      essential: true,
    });

    // Add volume for MongoDB data persistence
    mongodbTaskDefinition.addVolume({
      name: 'mongodb-data',
      host: {
        sourcePath: '/opt/mongodb/data',
      },
    });

    mongodbContainer.addMountPoints({
      sourceVolume: 'mongodb-data',
      containerPath: '/data/db',
      readOnly: false,
    });

    mongodbContainer.addPortMappings({
      containerPort: 27017,
      protocol: ecs.Protocol.TCP,
    });



    // Order Processing App Task Definition with X-Ray tracing
    const appTaskDefinition = new ecs.Ec2TaskDefinition(this, 'AppTaskDefinition', {
      executionRole: taskExecutionRole,
      taskRole: taskRole,
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    // X-Ray Daemon sidecar container for distributed tracing
    const xrayContainer = appTaskDefinition.addContainer('xray-daemon', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
      cpu: 32,
      memoryLimitMiB: 256,
      essential: false,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'xray-daemon',
        logGroup: tracingLogGroup,
      }),
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
      },
    });

    xrayContainer.addPortMappings({
      containerPort: 2000,
      protocol: ecs.Protocol.UDP,
    });

    const appContainer = appTaskDefinition.addContainer('order-processing-app', {
      image: ecs.ContainerImage.fromAsset('../../src/services/order-processing', {
        platform: Platform.LINUX_AMD64,
        buildArgs: {
          BUILDKIT_INLINE_CACHE: '1',
        },
        invalidation: {
          buildArgs: true,
        },
      }),
      cpu: 512, // Increased for luxury order processing
      memoryLimitMiB: 1024, // Increased for luxury order processing
      environment: {
        PROJECT_NAME: props.projectName,
        ENVIRONMENT: props.environment,
        MONGODB_URI: `mongodb://admin:Password123!@mongodb-service.shopsmart-${props.environment}.local:27017/luxury_orders?authSource=admin`,
        NODE_ENV: 'production',
        ENABLE_LUXURY_ORDERS: 'true',
        CRAFTING_TIME_TRACKING: 'true',
        INVENTORY_COORDINATION_ENABLED: 'true',
        ORDER_STATUS_NOTIFICATIONS: 'true',
        AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
        
        // OpenTelemetry configuration - use OTel Collector
        OTEL_EXPORTER_OTLP_ENDPOINT: ssm.StringParameter.valueForStringParameter(
          this,
          `/${props.projectName}/${props.environment}/opentelemetry/collector-url`
        ),
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_SERVICE_NAME: `order-processing-service-${cdk.Stack.of(this).account}`,
        OTEL_RESOURCE_ATTRIBUTES: `service.name=order-processing-service-${cdk.Stack.of(this).account},service.version=1.0.0,deployment.environment=${props.environment}`,
        
        // X-Ray configuration
        AWS_XRAY_TRACING_NAME: 'order-processing-service',
        AWS_XRAY_DAEMON_ADDRESS: 'localhost:2000',
        AWS_XRAY_CONTEXT_MISSING: 'LOG_ERROR',
        
        // CloudWatch configuration
        CLOUDWATCH_NAMESPACE: `${props.projectName}/${props.environment}/OrderProcessing`,
        CLOUDWATCH_LOG_GROUP: logGroup.logGroupName,
        CLOUDWATCH_METRICS_ENABLED: 'true',
        
        // Structured logging configuration
        LOG_LEVEL: 'INFO',
        LOG_FORMAT: 'json',
        CORRELATION_ID_HEADER: 'x-correlation-id',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'order-processing',
        logGroup: logGroup,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25),
      }),
      essential: true,
    });

    // Link X-Ray container to app container
    appContainer.addContainerDependencies({
      container: xrayContainer,
      condition: ecs.ContainerDependencyCondition.START,
    });

    appContainer.addPortMappings({
      containerPort: 8000,
      protocol: ecs.Protocol.TCP,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: false, // Internal ALB
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      loadBalancerName: `${props.projectName}-${props.environment}-order-proc`,
    });

    // Target Group for Order Processing Service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc: props.vpc,
      targetType: elbv2.TargetType.IP, // Use IP targets for AWSVPC mode
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      targetGroupName: `${props.projectName}-${props.environment}-order-proc-tg`,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ALB Listener
    alb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // Service Discovery Namespace
    const namespace = new cdk.aws_servicediscovery.PrivateDnsNamespace(this, 'ServiceDiscoveryNamespace', {
      name: `${props.projectName}-${props.environment}.local`,
      vpc: props.vpc,
      description: 'Service discovery namespace for order processing',
    });

    // Service Discovery Service for MongoDB
    const mongodbServiceDiscovery = new cdk.aws_servicediscovery.Service(this, 'MongoDBServiceDiscovery', {
      namespace: namespace,
      name: 'mongodb-service',
      description: 'Service discovery for MongoDB',
      dnsRecordType: cdk.aws_servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(60),
    });

    // Service Discovery Service for Order Processing App
    const appServiceDiscovery = new cdk.aws_servicediscovery.Service(this, 'AppServiceDiscovery', {
      namespace: namespace,
      name: 'order-processing-service',
      description: 'Service discovery for Order Processing app',
      dnsRecordType: cdk.aws_servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(60),
    });

    // MongoDB Service with Service Discovery
    const mongodbService = new ecs.Ec2Service(this, 'MongoDBService', {
      cluster: cluster,
      taskDefinition: mongodbTaskDefinition,
      desiredCount: 1,
      securityGroups: [mongodbSecurityGroup],
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      serviceName: `${props.projectName}-${props.environment}-mongodb`,
    });

    // Register MongoDB service with service discovery
    mongodbService.associateCloudMapService({
      service: mongodbServiceDiscovery,
    });

    // Order Processing App Service with Service Discovery
    const appService = new ecs.Ec2Service(this, 'AppService', {
      cluster: cluster,
      taskDefinition: appTaskDefinition,
      desiredCount: 1,
      securityGroups: [appSecurityGroup],
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      serviceName: `${props.projectName}-${props.environment}-order-processing`,
      enableExecuteCommand: true,
    });

    // Register app service with service discovery
    appService.associateCloudMapService({
      service: appServiceDiscovery,
    });

    // Attach service to target group
    appService.attachToApplicationTargetGroup(targetGroup);

    // ECS Service Auto Scaling
    const scalableTarget = appService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 1,
    });

    // CPU-based scaling
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // Memory-based scaling
    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // Request count-based scaling
    scalableTarget.scaleOnMetric('RequestCountScaling', {
      metric: targetGroup.metricRequestCountPerTarget({
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { upper: 100, change: 0 },
        { lower: 100, upper: 200, change: +1 },
        { lower: 200, upper: 500, change: +2 },
        { lower: 500, change: +3 },
      ],
      adjustmentType: applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(3),
    });

    // SSM Parameters for luxury order configuration
    new cdk.aws_ssm.StringParameter(this, 'LuxuryOrdersEnabledParam', {
      parameterName: `/${props.projectName}/${props.environment}/orders/luxury-orders-enabled`,
      stringValue: 'true',
      description: 'Enable luxury order processing features',
    });

    new cdk.aws_ssm.StringParameter(this, 'CraftingTimeTrackingParam', {
      parameterName: `/${props.projectName}/${props.environment}/orders/crafting-time-tracking`,
      stringValue: 'true',
      description: 'Enable crafting time tracking for luxury orders',
    });

    new cdk.aws_ssm.StringParameter(this, 'MaxCraftingTimeMonthsParam', {
      parameterName: `/${props.projectName}/${props.environment}/orders/max-crafting-time-months`,
      stringValue: '24',
      description: 'Maximum crafting time in months for luxury orders',
    });

    new cdk.aws_ssm.StringParameter(this, 'OrderStatusNotificationsParam', {
      parameterName: `/${props.projectName}/${props.environment}/orders/status-notifications-enabled`,
      stringValue: 'true',
      description: 'Enable order status notifications',
    });

    // Set outputs
    this.clusterName = cluster.clusterName;
    this.serviceArn = appService.serviceArn;
    this.albDnsName = alb.loadBalancerDnsName;

    // Enhanced CloudWatch Alarms with SNS notifications
    // ECS Service CPU Utilization
    const cpuAlarm = new cloudwatch.Alarm(this, 'ECSServiceHighCPU', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-high-cpu`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          ServiceName: appService.serviceName,
          ClusterName: cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing ECS service CPU utilization is high',
    });
    cpuAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // ECS Service Memory Utilization
    const memoryAlarm = new cloudwatch.Alarm(this, 'ECSServiceHighMemory', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-high-memory`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'MemoryUtilization',
        dimensionsMap: {
          ServiceName: appService.serviceName,
          ClusterName: cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing ECS service memory utilization is high',
    });
    memoryAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // ALB Target Health
    const unhealthyTargetsAlarm = new cloudwatch.Alarm(this, 'ALBUnhealthyTargets', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-unhealthy-targets`,
      metric: targetGroup.metricUnhealthyHostCount({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing has unhealthy targets',
    });
    unhealthyTargetsAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // ALB Response Time
    const responseTimeAlarm = new cloudwatch.Alarm(this, 'ALBHighResponseTime', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-high-response-time`,
      metric: targetGroup.metricTargetResponseTime({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 2,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing response time is high',
    });
    responseTimeAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // ALB 5XX Error Rate
    const errorRateAlarm = new cloudwatch.Alarm(this, 'ALBHighErrorRate', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-high-error-rate`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: {
          LoadBalancer: alb.loadBalancerFullName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing 5XX error rate is high',
    });
    errorRateAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // ECS Cluster CPU Utilization
    const clusterCpuAlarm = new cloudwatch.Alarm(this, 'ECSClusterHighCPU', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-cluster-high-cpu`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          ClusterName: cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 75,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order Processing ECS cluster CPU utilization is high',
    });
    clusterCpuAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // Custom Application Metrics Alarms
    const orderProcessingErrorsAlarm = new cloudwatch.Alarm(this, 'OrderProcessingErrors', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-errors`,
      metric: new cloudwatch.Metric({
        namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
        metricName: 'OrderProcessingErrors',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'High number of order processing errors',
    });
    orderProcessingErrorsAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    const orderLatencyAlarm = new cloudwatch.Alarm(this, 'OrderProcessingLatency', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-latency`,
      metric: new cloudwatch.Metric({
        namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
        metricName: 'OrderProcessingLatency',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000, // 5 seconds
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Order processing latency is high',
    });
    orderLatencyAlarm.addAlarmAction(new cloudwatchactions.SnsAction(alertTopic));

    // Enhanced CloudWatch Dashboard with comprehensive observability
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.projectName}-${props.environment}-order-processing`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'ECS Service Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'CPUUtilization',
                dimensionsMap: {
                  ServiceName: appService.serviceName,
                  ClusterName: cluster.clusterName,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'MemoryUtilization',
                dimensionsMap: {
                  ServiceName: appService.serviceName,
                  ClusterName: cluster.clusterName,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'RunningTaskCount',
                dimensionsMap: {
                  ServiceName: appService.serviceName,
                  ClusterName: cluster.clusterName,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(1),
              }),
            ],
            width: 12,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'ALB Performance Metrics',
            left: [
              targetGroup.metricRequestCount({
                period: cdk.Duration.minutes(5),
              }),
              targetGroup.metricTargetResponseTime({
                period: cdk.Duration.minutes(5),
              }),
            ],
            right: [
              targetGroup.metricUnhealthyHostCount({
                period: cdk.Duration.minutes(1),
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_5XX_Count',
                dimensionsMap: {
                  LoadBalancer: alb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
            ],
            width: 12,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Application Business Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
                metricName: 'OrdersCreated',
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
              new cloudwatch.Metric({
                namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
                metricName: 'OrderProcessingLatency',
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
                metricName: 'OrderProcessingErrors',
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
              new cloudwatch.Metric({
                namespace: `${props.projectName}/${props.environment}/OrderProcessing`,
                metricName: 'LuxuryOrdersProcessed',
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
            ],
            width: 12,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'ECS Cluster Resource Utilization',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'CPUUtilization',
                dimensionsMap: {
                  ClusterName: cluster.clusterName,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ECS',
                metricName: 'MemoryUtilization',
                dimensionsMap: {
                  ClusterName: cluster.clusterName,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
              }),
            ],
            width: 12,
            height: 6,
          }),
        ],
      ],
    });

    // CloudFormation Outputs
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ServiceArn', {
      value: this.serviceArn,
      description: 'ECS Service ARN',
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name',
    });

    new cdk.CfnOutput(this, 'CloudWatchLogGroup', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for application logs',
    });

    new cdk.CfnOutput(this, 'CloudWatchDashboard', {
      value: `https://${cdk.Stack.of(this).region}.console.aws.amazon.com/cloudwatch/home?region=${cdk.Stack.of(this).region}#dashboards:name=${props.projectName}-${props.environment}-order-processing`,
      description: 'CloudWatch Dashboard URL',
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS Topic ARN for CloudWatch Alarms',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'OrderProcessing');
  }
}
