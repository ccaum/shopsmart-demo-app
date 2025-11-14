import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { MonitoringAlarmsConstruct } from './constructs/monitoring-alarms-construct';
import { CloudWatchLogsConstruct } from './constructs/cloudwatch-logs-construct';
import { MonitoringDashboardsConstruct } from './constructs/monitoring-dashboards-construct';
import { NotificationConfigConstruct } from './constructs/notification-config-construct';

export interface ComprehensiveMonitoringStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  notificationEmail?: string;
  logRetentionDays?: logs.RetentionDays;
  slackWorkspaceId?: string;
  slackChannelId?: string;
  enableChatbot?: boolean;
}

export class ComprehensiveMonitoringStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly criticalAlarmTopic: sns.Topic;
  public readonly warningAlarmTopic: sns.Topic;
  public readonly infoAlarmTopic: sns.Topic;
  public readonly logGroups: { [key: string]: logs.LogGroup };
  public readonly serviceHealthDashboard: cloudwatch.Dashboard;
  public readonly performanceDashboard: cloudwatch.Dashboard;
  public readonly costOptimizationDashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ComprehensiveMonitoringStackProps) {
    super(scope, id, props);

    // Create CloudWatch Log Groups
    const logsConstruct = new CloudWatchLogsConstruct(this, 'CloudWatchLogs', {
      projectName: props.projectName,
      environment: props.environment,
      logRetentionDays: props.logRetentionDays || logs.RetentionDays.ONE_WEEK,
    });

    this.logGroups = logsConstruct.logGroups;

    // Create Notification Configuration
    const notificationConstruct = new NotificationConfigConstruct(this, 'NotificationConfig', {
      projectName: props.projectName,
      environment: props.environment,
      notificationEmail: props.notificationEmail,
      slackWorkspaceId: props.slackWorkspaceId,
      slackChannelId: props.slackChannelId,
      enableChatbot: props.enableChatbot,
    });

    this.criticalAlarmTopic = notificationConstruct.criticalAlarmTopic;
    this.warningAlarmTopic = notificationConstruct.warningAlarmTopic;
    this.infoAlarmTopic = notificationConstruct.infoAlarmTopic;
    this.alarmTopic = this.criticalAlarmTopic; // Backward compatibility

    // Create Monitoring Alarms
    const alarmsConstruct = new MonitoringAlarmsConstruct(this, 'MonitoringAlarms', {
      projectName: props.projectName,
      environment: props.environment,
      notificationEmail: props.notificationEmail,
    });

    // Note: alarmTopic is now handled internally by the MonitoringAlarmsConstruct

    // Create Monitoring Dashboards
    const dashboardsConstruct = new MonitoringDashboardsConstruct(this, 'MonitoringDashboards', {
      projectName: props.projectName,
      environment: props.environment,
      logGroups: this.logGroups,
    });

    this.serviceHealthDashboard = dashboardsConstruct.serviceHealthDashboard;
    this.performanceDashboard = dashboardsConstruct.performanceDashboard;
    this.costOptimizationDashboard = dashboardsConstruct.costOptimizationDashboard;

    // Create additional monitoring resources
    this.createAdditionalMonitoringResources(props);

    // Output important information
    this.createOutputs(props);
  }

  private createAdditionalMonitoringResources(props: ComprehensiveMonitoringStackProps) {
    // Create composite alarms for overall system health
    new cloudwatch.CompositeAlarm(this, 'SystemHealthCompositeAlarm', {
      compositeAlarmName: `${props.projectName}-${props.environment}-system-health`,
      alarmDescription: 'Overall system health composite alarm',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'ApiGatewayRouterHighErrorRateAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-api-gateway-router-high-error-rate`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'AuthLoginFailureAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-auth-login-failure-rate`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'CatalogErrorRateAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-catalog-error-rate`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'OrderCreationFailureAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-order-creation-failure-rate`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'HealthCheckLambdaErrorAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-health-check-lambda-errors`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
      actionsEnabled: true,
    });

    // Create performance composite alarm
    new cloudwatch.CompositeAlarm(this, 'PerformanceCompositeAlarm', {
      compositeAlarmName: `${props.projectName}-${props.environment}-performance-issues`,
      alarmDescription: 'Performance issues composite alarm',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'ApiGatewayRouterHighResponseTimeAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-api-gateway-router-high-response-time`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'CatalogSearchResponseTimeAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-catalog-search-response-time`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'OrderProcessingDurationAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-order-processing-duration`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'AuthLambdaDurationAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-auth-lambda-duration`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'HealthCheckLambdaDurationAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-health-check-lambda-duration`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
      actionsEnabled: true,
    });

    // Create API Gateway Router availability composite alarm
    new cloudwatch.CompositeAlarm(this, 'ApiGatewayAvailabilityCompositeAlarm', {
      compositeAlarmName: `${props.projectName}-${props.environment}-api-gateway-availability`,
      alarmDescription: 'API Gateway Router availability composite alarm',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'ApiGatewayRouterUnhealthyTargetsAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-api-gateway-router-unhealthy-targets`
          ),
          cloudwatch.AlarmState.ALARM
        ),
        cloudwatch.AlarmRule.fromAlarm(
          cloudwatch.Alarm.fromAlarmArn(
            this,
            'ServiceDiscoveryFailuresAlarmRef',
            `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${props.projectName}-${props.environment}-service-discovery-failures`
          ),
          cloudwatch.AlarmState.ALARM
        )
      ),
      actionsEnabled: true,
    });

    // Create custom metrics for optimization tracking
    new cloudwatch.Metric({
      namespace: `${props.projectName}/Optimization`,
      metricName: 'CostSavingsOpportunities',
      dimensionsMap: {
        'Environment': props.environment,
      },
    });

    new cloudwatch.Metric({
      namespace: `${props.projectName}/Optimization`,
      metricName: 'PerformanceImprovements',
      dimensionsMap: {
        'Environment': props.environment,
      },
    });
  }

  private createOutputs(props: ComprehensiveMonitoringStackProps) {
    // Dashboard URLs
    new cdk.CfnOutput(this, 'ServiceHealthDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${props.projectName}-${props.environment}-service-health`,
      description: 'URL to the Service Health Dashboard',
    });

    new cdk.CfnOutput(this, 'PerformanceDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${props.projectName}-${props.environment}-performance`,
      description: 'URL to the Performance Monitoring Dashboard',
    });

    new cdk.CfnOutput(this, 'CostOptimizationDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${props.projectName}-${props.environment}-cost-optimization`,
      description: 'URL to the Cost Optimization Dashboard',
    });

    // Log Groups
    new cdk.CfnOutput(this, 'LogGroupNames', {
      value: Object.keys(this.logGroups).join(', '),
      description: 'Names of all created log groups',
    });

    // SNS Topic
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'ARN of the SNS topic for alarm notifications',
    });

    // Log Insights Queries
    new cdk.CfnOutput(this, 'LogInsightsQueries', {
      value: JSON.stringify({
        'Performance Analysis': `fields @timestamp, service, correlation_id, duration_ms, performance_marker | filter performance_marker = true | sort @timestamp desc | limit 100`,
        'Error Analysis': `fields @timestamp, service, correlation_id, level, message, error_type | filter level = "ERROR" or level = "WARNING" | sort @timestamp desc | limit 100`,
        'Optimization Opportunities': `fields @timestamp, service, optimization_type, description, potential_improvement | filter optimization_opportunity = true | sort @timestamp desc | limit 50`,
      }),
      description: 'Pre-built CloudWatch Log Insights queries for monitoring',
    });

    // Monitoring Best Practices
    new cdk.CfnOutput(this, 'MonitoringBestPractices', {
      value: JSON.stringify({
        'Dashboard Usage': 'Use Service Health for operational monitoring, Performance for optimization, Cost for rightsizing',
        'Alert Response': 'Check composite alarms first, then drill down to specific service alarms',
        'Log Analysis': 'Use correlation IDs to trace requests across services',
        'Optimization': 'Review performance markers and optimization opportunities weekly',
      }),
      description: 'Best practices for using the monitoring setup',
    });
  }
}