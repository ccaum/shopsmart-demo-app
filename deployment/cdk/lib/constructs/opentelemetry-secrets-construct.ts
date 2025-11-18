import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface OpenTelemetrySecretsConstructProps {
  projectName: string;
  environment: string;
}

export class OpenTelemetrySecretsConstruct extends Construct {
  public readonly endpointParameterName: string;
  public readonly apiTokenParameterName: string;

  constructor(scope: Construct, id: string, props: OpenTelemetrySecretsConstructProps) {
    super(scope, id);

    // Read environment variables from .env.dynatrace file
    const envFilePath = path.join(__dirname, '../../../../.env.dynatrace');
    let dynatraceEndpoint = '';
    let dynatraceApiToken = '';

    if (fs.existsSync(envFilePath)) {
      try {
        const envContent = fs.readFileSync(envFilePath, 'utf8');
        const envLines = envContent.split('\n');
        
        for (const line of envLines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('DYNATRACE_ENDPOINT=')) {
            dynatraceEndpoint = trimmedLine.split('=')[1];
          } else if (trimmedLine.startsWith('DYNATRACE_API_TOKEN=')) {
            dynatraceApiToken = trimmedLine.split('=')[1];
          }
        }
      } catch (error) {
        console.warn(`Could not read .env.dynatrace file at ${envFilePath}: ${error}`);
      }
    } else {
      console.warn(`.env.dynatrace file not found at ${envFilePath} - skipping Dynatrace integration`);
    }

    if (!dynatraceEndpoint || !dynatraceApiToken) {
      console.warn('Dynatrace configuration not found - skipping OpenTelemetry SSM parameters');
      this.endpointParameterName = '';
      this.apiTokenParameterName = '';
      return;
    }

    // Create SSM parameters for OpenTelemetry configuration
    this.endpointParameterName = `/${props.projectName}/${props.environment}/opentelemetry/endpoint`;
    this.apiTokenParameterName = `/${props.projectName}/${props.environment}/opentelemetry/api-token`;

    new ssm.StringParameter(this, 'OpenTelemetryEndpointParameter', {
      parameterName: this.endpointParameterName,
      stringValue: dynatraceEndpoint,
      description: 'OpenTelemetry OTLP endpoint URL',
    });

    new ssm.StringParameter(this, 'OpenTelemetryApiTokenParameter', {
      parameterName: this.apiTokenParameterName,
      stringValue: dynatraceApiToken,
      description: 'OpenTelemetry API token for OTLP authentication',
      tier: ssm.ParameterTier.STANDARD,
    });
  }
}
