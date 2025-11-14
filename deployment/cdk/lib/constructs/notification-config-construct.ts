import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NotificationConfigConstructProps {
  projectName: string;
  environment: string;
  notificationEmail?: string;
  slackWorkspaceId?: string;
  slackChannelId?: string;
  enableChatbot?: boolean;
}

export class NotificationConfigConstruct extends Construct {
  public readonly criticalAlarmTopic: sns.Topic;
  public readonly warningAlarmTopic: sns.Topic;
  public readonly infoAlarmTopic: sns.Topic;
  public chatbotRole?: iam.Role;

  constructor(scope: Construct, id: string, props: NotificationConfigConstructProps) {
    super(scope, id);

    // Create SNS topics for different severity levels
    this.criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      topicName: `${props.projectName}-${props.environment}-critical-alarms`,
      displayName: 'Critical System Alarms',
    });

    this.warningAlarmTopic = new sns.Topic(this, 'WarningAlarmTopic', {
      topicName: `${props.projectName}-${props.environment}-warning-alarms`,
      displayName: 'Warning System Alarms',
    });

    this.infoAlarmTopic = new sns.Topic(this, 'InfoAlarmTopic', {
      topicName: `${props.projectName}-${props.environment}-info-alarms`,
      displayName: 'Informational System Alarms',
    });

    // Add email subscriptions if provided
    if (props.notificationEmail) {
      // Critical alarms go to email immediately
      this.criticalAlarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.notificationEmail)
      );

      // Warning alarms also go to email
      this.warningAlarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.notificationEmail)
      );

      // Info alarms can be filtered or sent to a different email if needed
      this.infoAlarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.notificationEmail)
      );
    }

    // Set up AWS Chatbot for Slack integration if enabled
    if (props.enableChatbot && props.slackWorkspaceId && props.slackChannelId) {
      this.setupChatbotIntegration(props);
    }

    // Create CloudFormation outputs
    this.createOutputs(props);
  }

  private setupChatbotIntegration(props: NotificationConfigConstructProps) {
    // Create IAM role for Chatbot
    this.chatbotRole = new iam.Role(this, 'ChatbotRole', {
      assumedBy: new iam.ServicePrincipal('chatbot.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchReadOnlyAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'),
      ],
    });

    // Add custom policy for Chatbot to describe alarms and get metrics
    this.chatbotRole!.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:DescribeAlarms',
        'cloudwatch:DescribeAlarmsForMetric',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:GetMetricData',
        'cloudwatch:ListMetrics',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
        'logs:GetLogEvents',
        'logs:FilterLogEvents',
      ],
      resources: ['*'],
    }));

    // Create Slack channel configuration for critical alarms
    new chatbot.SlackChannelConfiguration(this, 'CriticalAlarmsSlackChannel', {
      slackChannelConfigurationName: `${props.projectName}-${props.environment}-critical-alarms`,
      slackWorkspaceId: props.slackWorkspaceId!,
      slackChannelId: props.slackChannelId!,
      notificationTopics: [this.criticalAlarmTopic],
      role: this.chatbotRole,
      loggingLevel: chatbot.LoggingLevel.INFO,
    });

    // Create Slack channel configuration for warning alarms
    new chatbot.SlackChannelConfiguration(this, 'WarningAlarmsSlackChannel', {
      slackChannelConfigurationName: `${props.projectName}-${props.environment}-warning-alarms`,
      slackWorkspaceId: props.slackWorkspaceId!,
      slackChannelId: props.slackChannelId!,
      notificationTopics: [this.warningAlarmTopic],
      role: this.chatbotRole!,
      loggingLevel: chatbot.LoggingLevel.ERROR,
    });
  }

  private createOutputs(props: NotificationConfigConstructProps) {
    // SNS Topic ARNs
    new cdk.CfnOutput(this, 'CriticalAlarmTopicArn', {
      value: this.criticalAlarmTopic.topicArn,
      exportName: `${props.projectName}-${props.environment}-CriticalAlarmTopicArn`,
      description: 'ARN of the SNS topic for critical alarms',
    });

    new cdk.CfnOutput(this, 'WarningAlarmTopicArn', {
      value: this.warningAlarmTopic.topicArn,
      exportName: `${props.projectName}-${props.environment}-WarningAlarmTopicArn`,
      description: 'ARN of the SNS topic for warning alarms',
    });

    new cdk.CfnOutput(this, 'InfoAlarmTopicArn', {
      value: this.infoAlarmTopic.topicArn,
      exportName: `${props.projectName}-${props.environment}-InfoAlarmTopicArn`,
      description: 'ARN of the SNS topic for informational alarms',
    });

    // Notification configuration guide
    new cdk.CfnOutput(this, 'NotificationGuide', {
      value: JSON.stringify({
        'Critical Alarms': 'System outages, high error rates, service unavailability',
        'Warning Alarms': 'Performance degradation, resource utilization warnings',
        'Info Alarms': 'Scaling events, configuration changes, maintenance notifications',
        'Slack Integration': props.enableChatbot ? 'Enabled' : 'Disabled',
        'Email Notifications': props.notificationEmail ? 'Enabled' : 'Disabled',
      }),
      description: 'Guide for notification configuration and alarm severity levels',
    });

    // Runbook links
    new cdk.CfnOutput(this, 'AlarmRunbooks', {
      value: JSON.stringify({
        'API Gateway Router Issues': 'Check target health, review routing rules, verify service endpoints',
        'Service Health Failures': 'Check individual service health endpoints, review circuit breaker status',
        'Performance Degradation': 'Review response times, check resource utilization, analyze traffic patterns',
        'Authentication Issues': 'Check DynamoDB connectivity, review Lambda logs, verify API Gateway configuration',
        'Database Issues': 'Check connection pools, review query performance, verify backup status',
      }),
      description: 'Runbook guidance for common alarm scenarios',
    });
  }

  public getCriticalAlarmTopic(): sns.Topic {
    return this.criticalAlarmTopic;
  }

  public getWarningAlarmTopic(): sns.Topic {
    return this.warningAlarmTopic;
  }

  public getInfoAlarmTopic(): sns.Topic {
    return this.infoAlarmTopic;
  }
}