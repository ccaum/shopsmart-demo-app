import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  alertEmail?: string;
}

export class MonitoringStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly telemetryCollectorUrl: string;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // SNS Topic for Alerts
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${props.projectName}-${props.environment}-alerts`,
      displayName: 'ShopSmart Application Alerts',
    });

    // Add email subscription if provided
    if (props.alertEmail) {
      this.alertTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail)
      );
    }

    // Telemetry Collector Lambda
    const telemetryCollector = new lambda.Function(this, 'TelemetryCollector', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../../src/services/telemetry-collector'),
      functionName: `${props.projectName}-${props.environment}-telemetry-collector`,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ENVIRONMENT: props.environment
      }
    });

    // Grant SSM parameter read permissions
    telemetryCollector.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/shopsmart/prod/opentelemetry/*`
      ]
    }));

    // API Gateway for telemetry collector
    const api = new apigateway.RestApi(this, 'TelemetryCollectorApi', {
      restApiName: `${props.projectName}-${props.environment}-telemetry`,
      description: 'Telemetry collector API for frontend and backend services',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    const telemetry = api.root.addResource('telemetry');
    const signalType = telemetry.addResource('{type}');
    
    signalType.addMethod('POST', new apigateway.LambdaIntegration(telemetryCollector));

    this.telemetryCollectorUrl = api.url;

    // Outputs
    new cdk.CfnOutput(this, 'TelemetryCollectorUrl', {
      value: this.telemetryCollectorUrl,
      description: 'Telemetry Collector API URL',
      exportName: `${props.projectName}-${props.environment}-telemetry-url`
    });

    // Composite Alarms for Service Health
    // NOTE: Commented out because these reference alarms created in individual service stacks
    // which may not exist yet. Each service stack already has its own alarms.
    /*
    const productCatalogHealthAlarm = new cloudwatch.CompositeAlarm(this, 'ProductCatalogHealth', {
      compositeAlarmName: `${props.projectName}-${props.environment}-product-catalog-health`,
      alarmDescription: 'Overall health of Product Catalog service',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedCatalogUnhealthyTargets',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-catalog-unhealthy-targets`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedCatalogHighResponseTime',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-catalog-high-response-time`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedCatalogRDSHighCPU',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-catalog-rds-high-cpu`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
    });

    const orderProcessingHealthAlarm = new cloudwatch.CompositeAlarm(this, 'OrderProcessingHealth', {
      compositeAlarmName: `${props.projectName}-${props.environment}-order-processing-health`,
      alarmDescription: 'Overall health of Order Processing service',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedOrderUnhealthyTargets',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-order-processing-unhealthy-targets`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedOrderHighCPU',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-order-processing-high-cpu`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
    });

    const userAuthHealthAlarm = new cloudwatch.CompositeAlarm(this, 'UserAuthHealth', {
      compositeAlarmName: `${props.projectName}-${props.environment}-user-auth-health`,
      alarmDescription: 'Overall health of User Authentication service',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(this, 'ImportedAuth5XXErrors',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-auth-api-5xx-errors`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
    });

    // Add SNS actions to composite alarms
    [productCatalogHealthAlarm, orderProcessingHealthAlarm, userAuthHealthAlarm].forEach(alarm => {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
    });
    */

    // Executive Dashboard
    new cloudwatch.Dashboard(this, 'ExecutiveDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-executive`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Overall Request Volume',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'RequestCount',
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: 'Count',
                statistic: 'Sum',
              }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Error Rates',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_5XX_Count',
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: '5XXError',
                statistic: 'Sum',
              }),
            ],
            width: 12,
          }),
        ],
      ],
    });

    // Cost Optimization Dashboard
    new cloudwatch.Dashboard(this, 'CostOptimizationDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-cost-optimization`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'EC2 CPU Utilization (Optimization Target)',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/EC2',
                metricName: 'CPUUtilization',
                statistic: 'Average',
              }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'RDS IOPS Utilization',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/RDS',
                metricName: 'ReadIOPS',
                statistic: 'Average',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/RDS',
                metricName: 'WriteIOPS',
                statistic: 'Average',
              }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'DynamoDB Throttling Events',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ReadThrottledEvents',
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'WriteThrottledEvents',
                statistic: 'Sum',
              }),
            ],
            width: 12,
          }),
        ],
      ],
    });

    // Export SNS Topic ARN for other stacks
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      exportName: `${props.projectName}-${props.environment}-AlertTopicArn`,
      description: 'ARN of the central alert SNS topic',
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('StackType', 'Monitoring');
  }
}
