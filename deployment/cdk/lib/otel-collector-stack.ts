import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface OtelCollectorStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
}

export class OtelCollectorStack extends cdk.Stack {
  public readonly collectorUrl: string;

  constructor(scope: Construct, id: string, props: OtelCollectorStackProps) {
    super(scope, id, props);

    const vpc = props.vpc;

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OtelCollectorCluster', {
      vpc,
      clusterName: `${props.projectName}-${props.environment}-otel-collector`,
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'OtelCollectorTask', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Get Dynatrace config from SSM
    const dtEndpoint = ssm.StringParameter.valueFromLookup(
      this,
      '/shopsmart/prod/opentelemetry/endpoint'
    );
    const dtToken = ssm.StringParameter.valueFromLookup(
      this,
      '/shopsmart/prod/opentelemetry/api-token'
    );

    // Add container
    const container = taskDefinition.addContainer('OtelCollector', {
      image: ecs.ContainerImage.fromRegistry('dynatrace/dynatrace-otel-collector:latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'otel-collector',
        logGroup: new logs.LogGroup(this, 'OtelCollectorLogs', {
          logGroupName: `/ecs/${props.projectName}-${props.environment}-otel-collector`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      command: [
        '--config=env:OTEL_CONFIG',
      ],
      environment: {
        DT_ENDPOINT: dtEndpoint,
        DT_API_TOKEN: dtToken,
        OTEL_CONFIG: `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  otlphttp:
    endpoint: \${DT_ENDPOINT}
    headers:
      Authorization: "Api-Token \${DT_API_TOKEN}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
    metrics:
      receivers: [otlp]
      exporters: [otlphttp]
    logs:
      receivers: [otlp]
      exporters: [otlphttp]
`,
      },
      portMappings: [
        { containerPort: 4318, protocol: ecs.Protocol.TCP }, // OTLP HTTP
        { containerPort: 4317, protocol: ecs.Protocol.TCP }, // OTLP gRPC
      ],
    });

    // Security Group
    const securityGroup = new ec2.SecurityGroup(this, 'OtelCollectorSG', {
      vpc,
      description: 'Security group for OTel Collector',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(4318),
      'Allow OTLP HTTP from VPC'
    );

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(4317),
      'Allow OTLP gRPC from VPC'
    );

    // ECS Service
    const service = new ecs.FargateService(this, 'OtelCollectorService', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      securityGroups: [securityGroup],
      vpcSubnets: { subnets: vpc.privateSubnets },
      serviceName: `${props.projectName}-${props.environment}-otel-collector`,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'OtelCollectorALB', {
      vpc,
      internetFacing: false,
      loadBalancerName: `${props.projectName}-${props.environment}-otel`,
      vpcSubnets: { subnets: vpc.privateSubnets },
    });

    // Target Group for HTTP
    const httpTargetGroup = new elbv2.ApplicationTargetGroup(this, 'HttpTargetGroup', {
      vpc,
      port: 4318,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: '200-499',
      },
      targets: [service],
    });

    // Listener
    alb.addListener('HttpListener', {
      port: 4318,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [httpTargetGroup],
    });

    this.collectorUrl = `http://${alb.loadBalancerDnsName}:4318`;

    // Store OTel Collector URL in SSM Parameter Store for service discovery
    new ssm.StringParameter(this, 'OtelCollectorUrlParameter', {
      parameterName: `/${props.projectName}/${props.environment}/opentelemetry/collector-url`,
      stringValue: this.collectorUrl,
      description: 'OpenTelemetry Collector HTTP endpoint URL',
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.StringParameter(this, 'OtelCollectorDnsParameter', {
      parameterName: `/${props.projectName}/${props.environment}/opentelemetry/collector-dns`,
      stringValue: alb.loadBalancerDnsName,
      description: 'OpenTelemetry Collector ALB DNS name',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Outputs
    new cdk.CfnOutput(this, 'OtelCollectorUrl', {
      value: this.collectorUrl,
      description: 'OTel Collector HTTP endpoint',
      exportName: `${props.projectName}-${props.environment}-OtelCollectorUrl`,
    });

    new cdk.CfnOutput(this, 'OtelCollectorDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'OTel Collector ALB DNS name',
      exportName: `${props.projectName}-${props.environment}-OtelCollectorDns`,
    });

    // Tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'OtelCollector');
  }
}
