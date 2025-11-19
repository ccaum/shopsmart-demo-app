import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ProductCatalogConstructProps {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateAppSubnets: ec2.ISubnet[];
  privateDataSubnets: ec2.ISubnet[];
  availabilityZones: string[];
  projectName: string;
  environment: string;
  ec2InstanceType: string;
  rdsInstanceType: string;
  elasticacheNodeType: string;
  asgMinSize: number;
  asgMaxSize: number;
  asgDesiredCapacity: number;
  apiGatewayRouterAlbDnsName?: string; // Optional API Gateway Router ALB DNS name
}

export class ProductCatalogConstruct extends Construct {
  public readonly albDnsName: string;
  public readonly rdsEndpoint: string;
  public readonly redisEndpoint: string;
  public readonly catalogUpdatesTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ProductCatalogConstructProps) {
    super(scope, id);

    // S3 Bucket for backend application deployments
    // S3 Bucket for application deployment
    const deploymentBucket = new s3.Bucket(this, 'AppDeploymentBucket', {
      bucketName: `${props.projectName}-${props.environment}-deployments-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Deploy the Flask application to S3
    new s3deploy.BucketDeployment(this, 'AppDeployment', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../../../src/services/product-catalog')),
        s3deploy.Source.asset(path.join(__dirname, '../../../../src/database'))
      ],
      destinationBucket: deploymentBucket,
      destinationKeyPrefix: 'product-catalog/',
    });

    // Security Groups
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Product Catalog ALB',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');

    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Product Catalog EC2 instances',
      allowAllOutbound: true,
    });

    ec2SecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(80), 'Allow traffic from ALB to Flask app');
    
    // Allow traffic from API Gateway Router (will be configured via target registration)
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock), 
      ec2.Port.tcp(80), 
      'Allow traffic from API Gateway Router ALB'
    );

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RDSSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Product Catalog RDS',
      allowAllOutbound: true,
    });

    rdsSecurityGroup.addIngressRule(ec2SecurityGroup, ec2.Port.tcp(5432), 'Allow PostgreSQL traffic from EC2');

    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Product Catalog Redis',
      allowAllOutbound: true,
    });

    redisSecurityGroup.addIngressRule(ec2SecurityGroup, ec2.Port.tcp(6379), 'Allow Redis traffic from EC2');

    // SNS Topic for catalog updates (for compatibility with ServiceIntegration stack)
    this.catalogUpdatesTopic = new sns.Topic(this, 'CatalogUpdatesTopic', {
      displayName: 'Product Catalog Updates',
      topicName: `${props.projectName}-${props.environment}-catalog-updates`,
    });

    // Database credentials secret
    const dbCredentials = new secretsmanager.Secret(this, 'DBCredentials', {
      secretName: `${props.projectName}/${props.environment}/catalog/db-credentials`,
      description: 'Database credentials for Product Catalog service',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'catalog_admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
      },
    });

    // IAM Role for EC2 instances
    const ec2Role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    // S3 access policy for deployment bucket
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        deploymentBucket.bucketArn,
        `${deploymentBucket.bucketArn}/*`,
      ],
    }));

    // Secrets Manager access policy
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbCredentials.secretArn],
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

    // SSM parameter access for OTel and database configuration
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
      ],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${props.projectName}/${props.environment}/*`,
      ],
    }));

    // RDS PostgreSQL Instance
    const database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `${props.projectName}-${props.environment}-catalog-db-v2`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromSecret(dbCredentials),
      databaseName: 'shopsmart_catalog',
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateDataSubnets },
      securityGroups: [rdsSecurityGroup],
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      multiAz: false, // Single AZ for demo
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(0), // No backups to speed up deletion
      deleteAutomatedBackups: true, // Delete backups immediately
      deletionProtection: false, // Allow deletion for demo
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    
    // Apply removal policy to security group to ensure it's deleted
    rdsSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ECS Cluster for database seeding task
    const seedCluster = new ecs.Cluster(this, 'SeedCluster', {
      vpc: props.vpc,
      clusterName: `${props.projectName}-${props.environment}-seed-cluster`,
    });

    // Task execution role
    const taskExecutionRole = new iam.Role(this, 'SeedTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role with permissions to access Secrets Manager and SSM
    const taskRole = new iam.Role(this, 'SeedTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    
    dbCredentials.grantRead(taskRole);
    
    // Grant DynamoDB permissions for demo user creation
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DescribeTable',
        'dynamodb:PutItem',
        'dynamodb:GetItem',
      ],
      resources: [
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${props.projectName}-*-users`,
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${props.projectName}-*-carts`,
      ],
    }));

    // Task definition with container image built from Dockerfile
    const seedTaskDef = new ecs.FargateTaskDefinition(this, 'SeedTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const seedContainer = seedTaskDef.addContainer('SeedContainer', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../docker/seed-database'), {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'seed-database',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: '5432',
        DB_NAME: 'shopsmart_catalog',
        DB_USER: 'catalog_admin',
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
      },
    });

    // Security group for seed task
    const seedTaskSecurityGroup = new ec2.SecurityGroup(this, 'SeedTaskSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for database seeding task',
      allowAllOutbound: true,
    });

    // Allow seed task to connect to RDS
    database.connections.allowFrom(seedTaskSecurityGroup, ec2.Port.tcp(5432));

    // Lambda to trigger ECS task
    const triggerSeedFunction = new lambda.Function(this, 'TriggerSeedTask', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/trigger-seed-task')),
      timeout: cdk.Duration.minutes(15),
      environment: {
        CLUSTER_NAME: seedCluster.clusterName,
        TASK_DEFINITION: seedTaskDef.taskDefinitionArn,
        SUBNETS: props.privateAppSubnets.map(s => s.subnetId).join(','),
        SECURITY_GROUP: seedTaskSecurityGroup.securityGroupId,
      },
    });

    // Grant Lambda permissions to run ECS task
    triggerSeedFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:DescribeTasks'],
      resources: ['*'],
    }));
    
    triggerSeedFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskExecutionRole.roleArn, taskRole.roleArn],
    }));

    // Custom resource to trigger seeding (idempotent - safe to run on every deployment)
    const seedTrigger = new cdk.CustomResource(this, 'SeedDatabaseTrigger', {
      serviceToken: triggerSeedFunction.functionArn,
    });

    // Ensure database exists before seeding
    seedTrigger.node.addDependency(database);

    // ElastiCache Redis Cluster
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnetGroup', {
      description: 'Subnet group for Product Catalog Redis',
      subnetIds: props.privateDataSubnets.map(subnet => subnet.subnetId),
    });

    const redisCluster = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {
      replicationGroupDescription: 'Redis cluster for Product Catalog',
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 1, // Single node for demo
      engineVersion: '6.2',
      port: 6379,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
      automaticFailoverEnabled: false, // Disable automatic failover for single node
    });

    // Store database connection details in SSM Parameter Store
    new ssm.StringParameter(this, 'DbHostParameter', {
      parameterName: `/${props.projectName}/${props.environment}/product-catalog/db-host`,
      stringValue: database.instanceEndpoint.hostname,
      description: 'Product Catalog RDS hostname',
    });

    new ssm.StringParameter(this, 'DbNameParameter', {
      parameterName: `/${props.projectName}/${props.environment}/product-catalog/db-name`,
      stringValue: 'shopsmart_catalog',
      description: 'Product Catalog database name',
    });

    new ssm.StringParameter(this, 'DbSecretArnParameter', {
      parameterName: `/${props.projectName}/${props.environment}/product-catalog/db-secret-arn`,
      stringValue: dbCredentials.secretArn,
      description: 'Product Catalog database credentials secret ARN',
    });

    new ssm.StringParameter(this, 'RedisHostParameter', {
      parameterName: `/${props.projectName}/${props.environment}/product-catalog/redis-host`,
      stringValue: redisCluster.attrPrimaryEndPointAddress,
      description: 'Product Catalog Redis hostname',
    });

    // Application Load Balancer with X-Ray tracing
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnets: props.publicSubnets },
      securityGroup: albSecurityGroup,
    });

    // Enable X-Ray tracing on ALB
    const cfnLoadBalancer = alb.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnLoadBalancer.addPropertyOverride('LoadBalancerAttributes', [
      {
        Key: 'access_logs.s3.enabled',
        Value: 'false'
      }
    ]);

    // Target Group for Product Catalog Service
    const appTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AppTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/health',
        port: '80',
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: '200',
      },
      targetGroupName: `${props.projectName}-${props.environment}-prod-cat-tg`,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // HTTP Listener - all traffic goes to Flask app
    const listener = alb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([appTargetGroup]),
    });

    // User Data Script for EC2 instances - Deploy Flask app directly on port 80
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      '',
      '# Update system and install dependencies',
      'yum update -y',
      'yum install -y python3 python3-pip unzip jq',
      '',
      '# Install X-Ray daemon',
      'curl https://s3.us-east-2.amazonaws.com/aws-xray-assets.us-east-2/xray-daemon/aws-xray-daemon-3.x.rpm -o /tmp/xray.rpm',
      'yum install -y /tmp/xray.rpm',
      '',
      '# Create application directory',
      'mkdir -p /opt/product-catalog',
      'cd /opt/product-catalog',
      '',
      '# Get configuration from SSM',
      `REGION=${cdk.Stack.of(this).region}`,
      `DB_HOST=$(aws ssm get-parameter --name /${props.projectName}/${props.environment}/product-catalog/db-host --query Parameter.Value --output text --region $REGION)`,
      `DB_NAME=$(aws ssm get-parameter --name /${props.projectName}/${props.environment}/product-catalog/db-name --query Parameter.Value --output text --region $REGION)`,
      `DB_SECRET_ARN=$(aws ssm get-parameter --name /${props.projectName}/${props.environment}/product-catalog/db-secret-arn --query Parameter.Value --output text --region $REGION)`,
      `REDIS_HOST=$(aws ssm get-parameter --name /${props.projectName}/${props.environment}/product-catalog/redis-host --query Parameter.Value --output text --region $REGION)`,
      '',
      '# Download Flask application from S3',
      `aws s3 cp s3://${deploymentBucket.bucketName}/product-catalog/app.py app.py --region $REGION`,
      `aws s3 cp s3://${deploymentBucket.bucketName}/product-catalog/requirements.txt requirements.txt --region $REGION`,
      `aws s3 cp s3://${deploymentBucket.bucketName}/product-catalog/schema.sql schema.sql --region $REGION || echo "schema.sql not found"`,
      `aws s3 cp s3://${deploymentBucket.bucketName}/product-catalog/seed-data.sql seed-data.sql --region $REGION || echo "seed-data.sql not found"`,
      '',
      '# Initialize database',
      'if [ -f schema.sql ]; then',
      '  amazon-linux-extras install postgresql14 -y',
      '  DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id $DB_SECRET_ARN --region $REGION --query SecretString --output text | jq -r .password)',
      '  PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U catalog_admin -d $DB_NAME -c "DROP TABLE IF EXISTS products CASCADE;" || true',
      '  PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U catalog_admin -d $DB_NAME -f schema.sql',
      '  if [ -f seed-data.sql ]; then',
      '    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U catalog_admin -d $DB_NAME -f seed-data.sql',
      '  fi',
      'fi',
      '',
      '# Install Python 3.8 and PostgreSQL client for seeding',
      'amazon-linux-extras install python3.8 -y',
      'amazon-linux-extras install postgresql14 -y',
      'mkdir -p /tmp/database',
      `aws s3 cp s3://${deploymentBucket.bucketName}/product-catalog/ /tmp/database/ --recursive --region $REGION`,
      'chmod +x /tmp/database/seed_all.sh',
      'chmod +x /tmp/database/postgresql/migrate.sh',
      'DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id $DB_SECRET_ARN --region $REGION --query SecretString --output text | jq -r .password)',
      'DB_HOST=$DB_HOST DB_PORT=5432 DB_NAME=$DB_NAME DB_USER=catalog_admin DB_PASSWORD=$DB_PASSWORD /tmp/database/seed_all.sh || echo "Database seeding failed, continuing..."',
      '',
      '# Create virtual environment and install Flask dependencies',
      'python3 -m venv venv',
      'source venv/bin/activate',
      'pip install --upgrade pip',
      'pip install -r requirements.txt',
      '',
      '# Set environment variables from SSM',
      `OTEL_ENDPOINT=$(aws ssm get-parameter --name /${props.projectName}/${props.environment}/opentelemetry/collector-url --query Parameter.Value --output text --region $REGION)`,
      '',
      '# Create systemd service for Flask app on port 80',
      'cat > /etc/systemd/system/product-catalog.service << "EOF"',
      '[Unit]',
      'Description=Product Catalog Service (Port 80)',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/product-catalog',
      'Environment=PATH=/opt/product-catalog/venv/bin',
      'Environment=PORT=80',
      'EOF',
      '',
      '# Add environment variables to service file',
      `echo "Environment=PRODUCT_CATALOG_DB_HOST=$DB_HOST" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=PRODUCT_CATALOG_DB_NAME=$DB_NAME" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=PRODUCT_CATALOG_REDIS_HOST=$REDIS_HOST" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=AWS_DEFAULT_REGION=$REGION" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=DB_SECRET_ARN=$DB_SECRET_ARN" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=DEPLOYMENT_ENVIRONMENT=${props.environment}" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_ENDPOINT" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=OTEL_SERVICE_NAME=product-catalog-service-${cdk.Stack.of(this).account}" >> /etc/systemd/system/product-catalog.service`,
      `echo "Environment=OTEL_RESOURCE_ATTRIBUTES=service.name=product-catalog-service-${cdk.Stack.of(this).account},service.version=1.0.0,deployment.environment=${props.environment}" >> /etc/systemd/system/product-catalog.service`,
      '',
      '# Complete service file',
      'cat >> /etc/systemd/system/product-catalog.service << "EOF"',
      'ExecStart=/opt/product-catalog/venv/bin/python app.py',
      'Restart=always',
      'RestartSec=5',
      'KillMode=mixed',
      'TimeoutStopSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      '',
      '# Configure and start X-Ray daemon',
      'systemctl enable xray',
      'systemctl start xray',
      '',
      '# Enable and start the Flask service',
      'systemctl daemon-reload',
      'systemctl enable product-catalog',
      'systemctl start product-catalog',
      '',
      '# Wait for service to be ready',
      'sleep 10',
      '',
      '# Verify service is running and endpoints work',
      'systemctl status product-catalog',
      'curl -f http://localhost/health || exit 1',
      '',
      '# Check that port 80 is listening',
      'netstat -tlnp | grep :80',
      '',
      'echo "✅ Product Catalog Flask application deployed successfully on port 80"'
    );

    // Launch Template
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: new ec2.InstanceType(props.ec2InstanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      userData: userData,
    });

    // Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateAppSubnets },
      launchTemplate: launchTemplate,
      minCapacity: props.asgMinSize,
      maxCapacity: props.asgMaxSize,
      desiredCapacity: props.asgDesiredCapacity,
      healthCheck: autoscaling.HealthCheck.elb({
        grace: cdk.Duration.minutes(5),
      }),
    });

    // Attach ASG to Target Group
    asg.attachToApplicationTargetGroup(appTargetGroup);

    // Auto Scaling Policies
    // CPU-based scaling
    const cpuScalingPolicy = asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });

    // Request count-based scaling
    const requestCountScalingPolicy = asg.scaleOnRequestCount('RequestCountScaling', {
      targetRequestsPerMinute: 1000,
    });

    // Memory-based scaling (custom metric)
    asg.scaleOnMetric('MemoryScaling', {
      metric: new cloudwatch.Metric({
        namespace: 'CWAgent',
        metricName: 'mem_used_percent',
        dimensionsMap: {
          AutoScalingGroupName: asg.autoScalingGroupName,
        },
        statistic: 'Average',
      }),
      scalingSteps: [
        { upper: 50, change: 0 },
        { lower: 50, upper: 70, change: +1 },
        { lower: 70, upper: 85, change: +2 },
        { lower: 85, change: +3 },
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(5),
    });

    // Outputs
    this.albDnsName = alb.loadBalancerDnsName;
    this.rdsEndpoint = database.instanceEndpoint.hostname;
    this.redisEndpoint = redisCluster.attrPrimaryEndPointAddress;

    // CDK Outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: this.albDnsName,
      description: 'Product Catalog Load Balancer DNS Name',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.rdsEndpoint,
      description: 'Product Catalog Database Endpoint',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redisEndpoint,
      description: 'Product Catalog Redis Endpoint',
    });

    new cdk.CfnOutput(this, 'AppDeploymentBucketOutput', {
      value: deploymentBucket.bucketName,
      description: 'S3 Bucket for backend deployments',
    });

    new cdk.CfnOutput(this, 'CatalogUpdatesTopicArn', {
      value: this.catalogUpdatesTopic.topicArn,
      exportName: `${props.projectName}-${props.environment}-CatalogUpdatesTopicArn`,
      description: 'ARN of the SNS topic for catalog updates',
    });
  }
}