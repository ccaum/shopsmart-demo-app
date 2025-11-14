import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface DynatraceConstructProps {
  vpc: ec2.IVpc;
  cluster?: ecs.ICluster;
}

export class DynatraceConstruct extends Construct {
  public readonly oneAgentUserData: string[];

  constructor(scope: Construct, id: string, props: DynatraceConstructProps) {
    super(scope, id);

    // Store Dynatrace credentials in SSM Parameter Store
    const dynatraceEndpoint = new ssm.StringParameter(this, 'DynatraceEndpoint', {
      parameterName: '/dynatrace/endpoint',
      stringValue: process.env.DYNATRACE_ENDPOINT || 'https://placeholder.live.dynatrace.com',
      description: 'Dynatrace environment endpoint'
    });

    const dynatraceToken = new ssm.StringParameter(this, 'DynatraceToken', {
      parameterName: '/dynatrace/api-token',
      stringValue: process.env.DYNATRACE_API_TOKEN || 'placeholder-token',
      description: 'Dynatrace API token',
      type: ssm.ParameterType.SECURE_STRING
    });

    // OneAgent installation script for EC2 instances
    this.oneAgentUserData = [
      '#!/bin/bash',
      'yum update -y',
      
      // Install AWS CLI if not present
      'yum install -y awscli',
      
      // Get Dynatrace credentials from SSM
      `DYNATRACE_ENDPOINT=$(aws ssm get-parameter --name "${dynatraceEndpoint.parameterName}" --region ${cdk.Stack.of(this).region} --query 'Parameter.Value' --output text)`,
      `DYNATRACE_TOKEN=$(aws ssm get-parameter --name "${dynatraceToken.parameterName}" --with-decryption --region ${cdk.Stack.of(this).region} --query 'Parameter.Value' --output text)`,
      
      // Download and install OneAgent
      'cd /tmp',
      'wget -O Dynatrace-OneAgent-Linux.sh "$DYNATRACE_ENDPOINT/api/v1/deployment/installer/agent/unix/default/latest?arch=x86&flavor=default" --header="Authorization: Api-Token $DYNATRACE_TOKEN"',
      'chmod +x Dynatrace-OneAgent-Linux.sh',
      'sudo /bin/sh Dynatrace-OneAgent-Linux.sh --set-app-log-content-access=true --set-infra-only=false',
      
      // Configure OpenTelemetry Collector
      'mkdir -p /opt/otel-collector',
      'cd /opt/otel-collector',
      
      // Download OTel Collector
      'wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.89.0/otelcol-contrib_0.89.0_linux_amd64.tar.gz',
      'tar -xzf otelcol-contrib_0.89.0_linux_amd64.tar.gz',
      
      // Create OTel config with Dynatrace endpoint
      'cat > otel-config.yaml << EOF',
      'receivers:',
      '  otlp:',
      '    protocols:',
      '      grpc:',
      '        endpoint: 0.0.0.0:4317',
      '      http:',
      '        endpoint: 0.0.0.0:4318',
      '',
      'processors:',
      '  batch:',
      '    timeout: 1s',
      '    send_batch_size: 1024',
      '  resource:',
      '    attributes:',
      '    - key: service.name',
      '      value: shopsmart',
      '      action: upsert',
      '',
      'exporters:',
      '  otlp/dynatrace:',
      '    endpoint: $DYNATRACE_ENDPOINT/api/v2/otlp',
      '    headers:',
      '      Authorization: "Api-Token $DYNATRACE_TOKEN"',
      '',
      'service:',
      '  pipelines:',
      '    traces:',
      '      receivers: [otlp]',
      '      processors: [batch, resource]',
      '      exporters: [otlp/dynatrace]',
      '    metrics:',
      '      receivers: [otlp]',
      '      processors: [batch, resource]',
      '      exporters: [otlp/dynatrace]',
      '    logs:',
      '      receivers: [otlp]',
      '      processors: [batch, resource]',
      '      exporters: [otlp/dynatrace]',
      'EOF',
      
      // Create systemd service
      'cat > /etc/systemd/system/otel-collector.service << EOF',
      '[Unit]',
      'Description=OpenTelemetry Collector',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/otel-collector',
      'ExecStart=/opt/otel-collector/otelcol-contrib --config=/opt/otel-collector/otel-config.yaml',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      
      // Start services
      'systemctl daemon-reload',
      'systemctl enable otel-collector',
      'systemctl start otel-collector'
    ];

    // ECS Task Definition for containerized OneAgent
    if (props.cluster) {
      const taskDefinition = new ecs.FargateTaskDefinition(this, 'DynatraceTaskDef', {
        memoryLimitMiB: 512,
        cpu: 256
      });

      taskDefinition.addContainer('dynatrace-oneagent', {
        image: ecs.ContainerImage.fromRegistry('dynatrace/oneagent'),
        environment: {
          ONEAGENT_INSTALLER_SCRIPT_URL: `${dynatraceEndpoint.stringValue}/api/v1/deployment/installer/agent/unix/default/latest`,
          ONEAGENT_INSTALLER_TOKEN: dynatraceToken.stringValue
        },
        privileged: true,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'dynatrace-oneagent'
        })
      });
    }
  }
}
