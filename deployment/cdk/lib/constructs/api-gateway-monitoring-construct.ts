import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface ApiGatewayMonitoringConstructProps {
  projectName: string;
  environment: string;
  apiGatewayAlb: elbv2.ApplicationLoadBalancer;
  healthCheckLambda: lambda.Function;
  alarmTopic: sns.Topic;
}

export class ApiGatewayMonitoringConstruct extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: ApiGatewayMonitoringConstructProps) {
    super(scope, id);

    this.alarms = [];

    // Create API Gateway Router specific dashboard
    this.dashboard = this.createApiGatewayDashboard(props);

    // Create API Gateway Router specific alarms
    this.createApiGatewayAlarms(props);

    // Create custom metrics for API Gateway Router
    this.createCustomMetrics(props);
  }

  private createApiGatewayDashboard(props: ApiGatewayMonitoringConstructProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'ApiGatewayRouterDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-api-gateway-router`,
      defaultInterval: cdk.Duration.minutes(15),
    });

    // API Gateway Router Overview
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# API Gateway Router Monitoring Dashboard\n\nThis dashboard provides comprehensive monitoring for the API Gateway Router including request metrics, health checks, and service routing.',
        width: 24,
        height: 2,
      })
    );

    // Request Metrics Section
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Request Metrics & Routing',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Request count and success rate
      new cloudwatch.GraphWidget({
        title: 'Request Volume & Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Total Requests',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_2XX_Count',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Successful Requests (2XX)',
          }),
        ],
        right: [
          new cloudwatch.MathExpression({
            expression: 'm1 / m2 * 100',
            usingMetrics: {
              m1: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_2XX_Count',
                dimensionsMap: {
                  LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
              m2: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'RequestCount',
                dimensionsMap: {
                  LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
            },
            label: 'Success Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Error rates by type
      new cloudwatch.GraphWidget({
        title: 'Error Rates by Type',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_4XX_Count',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Client Errors (4XX)',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Server Errors (5XX)',
          }),
        ],
        right: [
          new cloudwatch.MathExpression({
            expression: '(m1 + m2) / m3 * 100',
            usingMetrics: {
              m1: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_4XX_Count',
                dimensionsMap: {
                  LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
              m2: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'HTTPCode_Target_5XX_Count',
                dimensionsMap: {
                  LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
              m3: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'RequestCount',
                dimensionsMap: {
                  LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
                },
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
              }),
            },
            label: 'Total Error Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Response times
      new cloudwatch.GraphWidget({
        title: 'Response Times',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Average Response Time',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
            label: 'P95 Response Time',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'p99',
            period: cdk.Duration.minutes(5),
            label: 'P99 Response Time',
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Target Health Section
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Target Health & Service Routing',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Target health by target group
      new cloudwatch.GraphWidget({
        title: 'Target Health by Service',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HealthyHostCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Healthy Targets',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'UnHealthyHostCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Unhealthy Targets',
          }),
        ],
        width: 12,
        height: 6,
      }),

      // Connection metrics
      new cloudwatch.GraphWidget({
        title: 'Connection Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'NewConnectionCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'New Connections',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'ActiveConnectionCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Active Connections',
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Health Check Lambda Section
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Health Check Aggregation Lambda',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Lambda performance metrics
      new cloudwatch.GraphWidget({
        title: 'Health Check Lambda Performance',
        left: [
          props.healthCheckLambda.metricDuration({
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Average Duration',
          }),
          props.healthCheckLambda.metricDuration({
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
            label: 'P95 Duration',
          }),
        ],
        right: [
          props.healthCheckLambda.metricInvocations({
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Invocations',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Lambda errors and throttles
      new cloudwatch.GraphWidget({
        title: 'Health Check Lambda Errors',
        left: [
          props.healthCheckLambda.metricErrors({
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Errors',
          }),
          props.healthCheckLambda.metricThrottles({
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Throttles',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Lambda concurrent executions
      new cloudwatch.GraphWidget({
        title: 'Health Check Lambda Concurrency',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'ConcurrentExecutions',
            dimensionsMap: {
              FunctionName: props.healthCheckLambda.functionName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Concurrent Executions',
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    return dashboard;
  }

  private createApiGatewayAlarms(props: ApiGatewayMonitoringConstructProps) {
    // High error rate alarm
    const errorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-high-error-rate`,
      alarmDescription: 'API Gateway Router error rate is too high',
      metric: new cloudwatch.MathExpression({
        expression: '(m1 + m2) / m3 * 100',
        usingMetrics: {
          m1: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_4XX_Count',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          m2: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          m3: new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: {
              LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
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
    });
    errorRateAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
    this.alarms.push(errorRateAlarm);

    // High response time alarm
    const responseTimeAlarm = new cloudwatch.Alarm(this, 'HighResponseTimeAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-high-response-time`,
      alarmDescription: 'API Gateway Router response time is too high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: {
          LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 2, // 2 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    responseTimeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
    this.alarms.push(responseTimeAlarm);

    // Unhealthy targets alarm
    const unhealthyTargetsAlarm = new cloudwatch.Alarm(this, 'UnhealthyTargetsAlarm', {
      alarmName: `${props.projectName}-${props.environment}-api-gateway-router-unhealthy-targets`,
      alarmDescription: 'API Gateway Router has unhealthy targets',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          LoadBalancer: props.apiGatewayAlb.loadBalancerFullName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unhealthyTargetsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
    this.alarms.push(unhealthyTargetsAlarm);

    // Health Check Lambda error alarm
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'HealthCheckLambdaErrorAlarm', {
      alarmName: `${props.projectName}-${props.environment}-health-check-lambda-errors`,
      alarmDescription: 'Health Check Lambda is experiencing errors',
      metric: props.healthCheckLambda.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
    this.alarms.push(lambdaErrorAlarm);

    // Health Check Lambda duration alarm
    const lambdaDurationAlarm = new cloudwatch.Alarm(this, 'HealthCheckLambdaDurationAlarm', {
      alarmName: `${props.projectName}-${props.environment}-health-check-lambda-duration`,
      alarmDescription: 'Health Check Lambda taking too long to execute',
      metric: props.healthCheckLambda.metricDuration({
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 15000, // 15 seconds
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaDurationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
    this.alarms.push(lambdaDurationAlarm);
  }

  private createCustomMetrics(props: ApiGatewayMonitoringConstructProps) {
    // Create custom metrics for API Gateway Router monitoring
    new cloudwatch.Metric({
      namespace: `${props.projectName}/ApiGatewayRouter`,
      metricName: 'ServiceAvailability',
      dimensionsMap: {
        'Environment': props.environment,
        'LoadBalancer': props.apiGatewayAlb.loadBalancerName,
      },
    });

    new cloudwatch.Metric({
      namespace: `${props.projectName}/ApiGatewayRouter`,
      metricName: 'RoutingEfficiency',
      dimensionsMap: {
        'Environment': props.environment,
        'LoadBalancer': props.apiGatewayAlb.loadBalancerName,
      },
    });

    new cloudwatch.Metric({
      namespace: `${props.projectName}/ServiceDiscovery`,
      metricName: 'DiscoveryFailures',
      dimensionsMap: {
        'Environment': props.environment,
      },
    });
  }
}