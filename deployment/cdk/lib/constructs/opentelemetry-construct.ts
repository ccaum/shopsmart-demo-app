import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

export interface OpenTelemetryConfig {
  endpoint: string;
  apiToken?: string;
  environmentId?: string;
}

export interface OpenTelemetryConstructProps {
  projectName: string;
  environment: string;
  otelConfig: OpenTelemetryConfig;
}

export class OpenTelemetryConstruct extends Construct {
  public readonly otelCollectorLayer: lambda.ILayerVersion;
  public readonly otelEnvironmentVariables: { [key: string]: string };
  public readonly otelTaskDefinition: ecs.TaskDefinition;

  constructor(scope: Construct, id: string, props: OpenTelemetryConstructProps) {
    super(scope, id);

    // Store OpenTelemetry configuration in SSM
    const otelEndpointParam = new ssm.StringParameter(this, 'OTelEndpoint', {
      parameterName: `/${props.projectName}/${props.environment}/otel/endpoint`,
      stringValue: props.otelConfig.endpoint,
      description: 'OpenTelemetry collector endpoint',
    });

    const otelTokenParam = new ssm.StringParameter(this, 'OTelToken', {
      parameterName: `/${props.projectName}/${props.environment}/otel/token`,
      stringValue: props.otelConfig.apiToken || '',
      description: 'OpenTelemetry authentication token',
    });

    // OpenTelemetry Lambda Layer (AWS Distro for OpenTelemetry)
    this.otelCollectorLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'OTelLayer',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:901920570463:layer:aws-otel-python-amd64-ver-1-20-0:1`
    );

    // OpenTelemetry environment variables
    this.otelEnvironmentVariables = {
      // Core OpenTelemetry configuration
      OTEL_SERVICE_NAME: `shopsmart-${props.environment}`,
      OTEL_RESOURCE_ATTRIBUTES: `service.name=shopsmart,service.version=1.0.0,deployment.environment=${props.environment}`,
      
      // Exporter configuration for Dynatrace
      OTEL_EXPORTER_OTLP_ENDPOINT: props.otelConfig.endpoint + '/api/v2/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Api-Token ${props.otelConfig.apiToken}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      
      // Instrumentation configuration
      OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED: 'true',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: 'content-type,user-agent',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_RESPONSE: 'content-type',
      
      // Sampling configuration
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.1',
      
      // AWS Lambda specific
      AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
      OTEL_PROPAGATORS: 'tracecontext,baggage,xray',
    };

    // ECS Task Definition for OpenTelemetry Collector sidecar
    this.otelTaskDefinition = new ecs.FargateTaskDefinition(this, 'OTelCollectorTask', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // OpenTelemetry Collector container
    this.otelTaskDefinition.addContainer('otel-collector', {
      image: ecs.ContainerImage.fromRegistry('otel/opentelemetry-collector-contrib:latest'),
      memoryLimitMiB: 256,
      cpu: 128,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'otel-collector',
        logGroup: new cdk.aws_logs.LogGroup(this, 'OTelCollectorLogGroup', {
          logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-otel-collector`,
          retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        }),
      }),
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: props.otelConfig.endpoint + '/api/v2/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Api-Token ${props.otelConfig.apiToken}`,
      },
      portMappings: [
        { containerPort: 4317, protocol: ecs.Protocol.TCP }, // OTLP gRPC
        { containerPort: 4318, protocol: ecs.Protocol.TCP }, // OTLP HTTP
        { containerPort: 8888, protocol: ecs.Protocol.TCP }, // Metrics
      ],
    });

    // Output configuration
    new cdk.CfnOutput(this, 'OpenTelemetryEndpoint', {
      value: props.otelConfig.endpoint,
      description: `OpenTelemetry endpoint for ${props.environment}`,
      exportName: `${props.projectName}-${props.environment}-otel-endpoint`,
    });

    new cdk.CfnOutput(this, 'OpenTelemetryServiceName', {
      value: `shopsmart-${props.environment}`,
      description: `OpenTelemetry service name for ${props.environment}`,
      exportName: `${props.projectName}-${props.environment}-otel-service-name`,
    });
  }

  // Helper method to create IAM policy for OpenTelemetry
  public createOTelPolicy(): iam.PolicyStatement {
    return new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    });
  }

  // Get OpenTelemetry configuration for EC2 user data
  public getEC2UserData(): string {
    return `
# Install OpenTelemetry Collector
wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.88.0/otelcol-contrib_0.88.0_linux_amd64.tar.gz
tar -xzf otelcol-contrib_0.88.0_linux_amd64.tar.gz
sudo mv otelcol-contrib /usr/local/bin/

# Create OpenTelemetry configuration
cat > /etc/otel-collector-config.yaml << EOF
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
  resource:
    attributes:
    - key: service.name
      value: shopsmart-${this.node.tryGetContext('environment') || 'prod'}
      action: upsert

exporters:
  otlp:
    endpoint: ${this.node.tryGetContext('otelEndpoint') || 'https://dynatrace.com'}/api/v2/otlp
    headers:
      Authorization: Api-Token ${this.node.tryGetContext('otelToken') || 'TOKEN'}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp]
    logs:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp]
EOF

# Start OpenTelemetry Collector
sudo /usr/local/bin/otelcol-contrib --config=/etc/otel-collector-config.yaml &
`;
  }
}
