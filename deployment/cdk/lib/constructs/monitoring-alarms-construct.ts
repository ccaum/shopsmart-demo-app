import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface MonitoringAlarmsConstructProps {
  projectName: string;
  environment: string;
  notificationEmail?: string;
}

export class MonitoringAlarmsConstruct extends Construct {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringAlarmsConstructProps) {
    super(scope, id);

    // SNS Topic for alarm notifications
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.projectName}-${props.environment}-alarms`,
      displayName: 'ShopSmart Application Alarms',
    });

    // Add email subscription if provided
    if (props.notificationEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.notificationEmail)
      );
    }

    // Artisan Desk Storefront Alarms
    this.createStorefrontAlarms(props);

    // Authentication Service Alarms
    this.createAuthServiceAlarms(props);

    // Product Catalog Service Alarms
    this.createCatalogServiceAlarms(props);

    // Order Processing Service Alarms
    this.createOrderServiceAlarms(props);

    // Infrastructure Alarms
    this.createInfrastructureAlarms(props);

    // Business Metrics Alarms
    this.createBusinessMetricsAlarms(props);

    // API Gateway Router Alarms
    this.createApiGatewayRouterAlarms(props);
  }

  private createAuthServiceAlarms(props: MonitoringAlarmsConstructProps) {
    // Login failure rate alarm
    new cloudwatch.Alarm(this, 'AuthLoginFailureRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-auth-login-failure-rate`,
      alarmDescription: 'High login failure rate detected',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Auth',
        metricName: 'LoginFailureRate',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // DynamoDB throttling alarm
    new cloudwatch.Alarm(this, 'AuthDynamoDBThrottleAlarm', {
      alarmName: `${props.projectName}-${props.environment}-auth-dynamodb-throttles`,
      alarmDescription: 'DynamoDB throttling detected in auth service',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Auth',
        metricName: 'DynamoDBThrottles',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Cart operation errors alarm
    new cloudwatch.Alarm(this, 'AuthCartErrorsAlarm', {
      alarmName: `${props.projectName}-${props.environment}-auth-cart-errors`,
      alarmDescription: 'High cart operation error rate',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Auth',
        metricName: 'Errors',
        dimensionsMap: {
          'Function': 'cart'
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Lambda duration alarm
    new cloudwatch.Alarm(this, 'AuthLambdaDurationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-auth-lambda-duration`,
      alarmDescription: 'Auth Lambda functions taking too long',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Auth',
        metricName: 'LoginDuration',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000, // 5 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createCatalogServiceAlarms(props: MonitoringAlarmsConstructProps) {
    // Search response time alarm
    new cloudwatch.Alarm(this, 'CatalogSearchResponseTimeAlarm', {
      alarmName: `${props.projectName}-${props.environment}-catalog-search-response-time`,
      alarmDescription: 'Product search taking too long',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Catalog',
        metricName: 'SearchResponseTime',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 2000, // 2 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Cache hit rate alarm
    new cloudwatch.Alarm(this, 'CatalogCacheHitRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-catalog-cache-hit-rate`,
      alarmDescription: 'Low cache hit rate detected',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Catalog',
        metricName: 'CacheHitRate',
        statistic: 'Average',
        period: cdk.Duration.minutes(10),
      }),
      threshold: 70, // 70%
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Database connection pool utilization alarm
    new cloudwatch.Alarm(this, 'CatalogDBConnectionPoolAlarm', {
      alarmName: `${props.projectName}-${props.environment}-catalog-db-connection-pool`,
      alarmDescription: 'High database connection pool utilization',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Catalog',
        metricName: 'DatabaseConnectionPoolUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80, // 80%
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Error rate alarm
    new cloudwatch.Alarm(this, 'CatalogErrorRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-catalog-error-rate`,
      alarmDescription: 'High error rate in catalog service',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Catalog',
        metricName: 'ErrorRate',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createOrderServiceAlarms(props: MonitoringAlarmsConstructProps) {
    // Order creation failure rate alarm
    new cloudwatch.Alarm(this, 'OrderCreationFailureRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-order-creation-failure-rate`,
      alarmDescription: 'High order creation failure rate',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Orders',
        metricName: 'OrderCreationAttempts',
        dimensionsMap: {
          'Status': 'Failed'
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Order processing duration alarm
    new cloudwatch.Alarm(this, 'OrderProcessingDurationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-order-processing-duration`,
      alarmDescription: 'Order processing taking too long',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Orders',
        metricName: 'OrderProcessingDuration',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10000, // 10 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Inventory validation failures alarm
    new cloudwatch.Alarm(this, 'OrderInventoryValidationFailuresAlarm', {
      alarmName: `${props.projectName}-${props.environment}-order-inventory-validation-failures`,
      alarmDescription: 'High inventory validation failure rate',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Orders',
        metricName: 'InventoryValidationFailures',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Service communication failures alarm
    new cloudwatch.Alarm(this, 'OrderServiceCommunicationFailuresAlarm', {
      alarmName: `${props.projectName}-${props.environment}-order-service-communication-failures`,
      alarmDescription: 'High service communication failure rate',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Orders',
        metricName: 'ServiceCommunication',
        dimensionsMap: {
          'Status': 'Failed'
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createInfrastructureAlarms(props: MonitoringAlarmsConstructProps) {
    // EC2 CPU utilization alarm
    new cloudwatch.Alarm(this, 'EC2CPUUtilizationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-ec2-cpu-utilization`,
      alarmDescription: 'High EC2 CPU utilization',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80, // 80%
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // RDS CPU utilization alarm
    new cloudwatch.Alarm(this, 'RDSCPUUtilizationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-rds-cpu-utilization`,
      alarmDescription: 'High RDS CPU utilization',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 75, // 75%
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // ECS CPU utilization alarm
    new cloudwatch.Alarm(this, 'ECSCPUUtilizationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-ecs-cpu-utilization`,
      alarmDescription: 'High ECS CPU utilization',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80, // 80%
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // DynamoDB throttling alarm
    new cloudwatch.Alarm(this, 'DynamoDBThrottleAlarm', {
      alarmName: `${props.projectName}-${props.environment}-dynamodb-throttles`,
      alarmDescription: 'DynamoDB throttling detected',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createStorefrontAlarms(props: MonitoringAlarmsConstructProps) {
    // Storefront high error rate alarm
    new cloudwatch.Alarm(this, 'StorefrontHighErrorRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-storefront-high-error-rate`,
      alarmDescription: 'High error rate on storefront',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Storefront',
        metricName: 'ErrorRate',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5, // 5% error rate
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Storefront slow page load alarm
    new cloudwatch.Alarm(this, 'StorefrontSlowPageLoadAlarm', {
      alarmName: `${props.projectName}-${props.environment}-storefront-slow-page-load`,
      alarmDescription: 'Storefront page load time is too slow',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Storefront',
        metricName: 'PageLoadTime',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3000, // 3 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Cart abandonment rate alarm
    new cloudwatch.Alarm(this, 'CartAbandonmentRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-cart-abandonment-rate`,
      alarmDescription: 'High cart abandonment rate detected',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Cart',
        metricName: 'AbandonmentRate',
        statistic: 'Average',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 70, // 70% abandonment rate
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createBusinessMetricsAlarms(props: MonitoringAlarmsConstructProps) {
    // Low conversion rate alarm
    new cloudwatch.Alarm(this, 'LowConversionRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-low-conversion-rate`,
      alarmDescription: 'Conversion rate has dropped significantly',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Business',
        metricName: 'ConversionRate',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 2, // 2% conversion rate
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // High inventory stockout rate alarm
    new cloudwatch.Alarm(this, 'HighStockoutRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-high-stockout-rate`,
      alarmDescription: 'High inventory stockout rate detected',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Inventory',
        metricName: 'StockoutRate',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 15, // 15% stockout rate
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Revenue drop alarm
    new cloudwatch.Alarm(this, 'RevenueDrop Alarm', {
      alarmName: `${props.projectName}-${props.environment}-revenue-drop`,
      alarmDescription: 'Significant drop in daily revenue detected',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/Business',
        metricName: 'DailyRevenue',
        statistic: 'Sum',
        period: cdk.Duration.hours(6),
      }),
      threshold: 50000, // $50,000 daily revenue threshold
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }

  private createApiGatewayRouterAlarms(props: MonitoringAlarmsConstructProps) {
    // API Gateway Router high error rate alarm
    new cloudwatch.Alarm(this, 'ApiGatewayRouterHighErrorRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-high-error-rate`,
      alarmDescription: 'High error rate detected in API Gateway Router',
      metric: new cloudwatch.MathExpression({
        expression: '(m1 + m2) / m3 * 100',
        usingMetrics: {
          m1: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_4XX_Count',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          m2: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          m3: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        },
        label: 'Error Rate (%)',
      }),
      threshold: 5, // 5% error rate
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // API Gateway Router high response time alarm
    new cloudwatch.Alarm(this, 'ApiGatewayRouterHighResponseTimeAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-high-response-time`,
      alarmDescription: 'High response time detected in API Gateway Router',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: {
          LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 2, // 2 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // API Gateway Router unhealthy targets alarm
    new cloudwatch.Alarm(this, 'ApiGatewayRouterUnhealthyTargetsAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-unhealthy-targets`,
      alarmDescription: 'Unhealthy targets detected in API Gateway Router',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Health Check Lambda error alarm
    new cloudwatch.Alarm(this, 'HealthCheckLambdaErrorAlarm', {
      alarmName: `${props.projectName}-${props.environment}-health-check-lambda-errors`,
      alarmDescription: 'Health Check Lambda is experiencing errors',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: {
          FunctionName: `${props.projectName}-${props.environment}-health-check`,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Health Check Lambda duration alarm
    new cloudwatch.Alarm(this, 'HealthCheckLambdaDurationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-health-check-lambda-duration`,
      alarmDescription: 'Health Check Lambda taking too long to execute',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensionsMap: {
          FunctionName: `${props.projectName}-${props.environment}-health-check`,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 15000, // 15 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Service discovery failures alarm (based on health check logs)
    new cloudwatch.Alarm(this, 'ServiceDiscoveryFailuresAlarm', {
      alarmName: `${props.projectName}-${props.environment}-service-discovery-failures`,
      alarmDescription: 'Service discovery failures detected in health checks',
      metric: new cloudwatch.Metric({
        namespace: 'ShopSmart/ServiceDiscovery',
        metricName: 'DiscoveryFailures',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }
}