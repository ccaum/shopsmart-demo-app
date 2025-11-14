import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MonitoringDashboardsConstructProps {
  projectName: string;
  environment: string;
  logGroups: { [key: string]: logs.LogGroup };
}

export class MonitoringDashboardsConstruct extends Construct {
  public readonly serviceHealthDashboard: cloudwatch.Dashboard;
  public readonly performanceDashboard: cloudwatch.Dashboard;
  public readonly costOptimizationDashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringDashboardsConstructProps) {
    super(scope, id);

    // Create service health overview dashboard
    this.serviceHealthDashboard = this.createServiceHealthDashboard(props);

    // Create performance monitoring dashboard
    this.performanceDashboard = this.createPerformanceDashboard(props);

    // Create cost optimization dashboard
    this.costOptimizationDashboard = this.createCostOptimizationDashboard(props);
  }

  private createServiceHealthDashboard(props: MonitoringDashboardsConstructProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'ServiceHealthDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-service-health`,
      defaultInterval: cdk.Duration.hours(1),
    });

    // API Gateway Router Health (New Section)
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# API Gateway Router Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // API Gateway Router request metrics
      new cloudwatch.GraphWidget({
        title: 'API Gateway Router Requests',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'RequestCount',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Total Requests',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_2XX_Count',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Successful Requests',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_4XX_Count',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: '4XX Errors',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HTTPCode_Target_5XX_Count',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: '5XX Errors',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // API Gateway Router response times
      new cloudwatch.GraphWidget({
        title: 'API Gateway Router Response Times',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Average Response Time',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
            label: 'P95 Response Time',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // API Gateway Router target health
      new cloudwatch.GraphWidget({
        title: 'API Gateway Router Target Health',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'HealthyHostCount',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Healthy Targets',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApplicationELB',
            metricName: 'UnHealthyHostCount',
            dimensionsMap: {
              LoadBalancer: `app/${props.projectName}-${props.environment}-api-gateway/*`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Unhealthy Targets',
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Health Check Aggregation Metrics
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Health Check Aggregation',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Health Check Lambda metrics
      new cloudwatch.GraphWidget({
        title: 'Health Check Lambda Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: {
              FunctionName: `${props.projectName}-${props.environment}-health-check`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Execution Duration',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: {
              FunctionName: `${props.projectName}-${props.environment}-health-check`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Invocations',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            dimensionsMap: {
              FunctionName: `${props.projectName}-${props.environment}-health-check`,
            },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            label: 'Errors',
          }),
        ],
        width: 12,
        height: 6,
      }),

      // Service health status from aggregated health check
      new cloudwatch.LogQueryWidget({
        title: 'Service Health Status',
        logGroupNames: [`/aws/lambda/${props.projectName}-${props.environment}-health-check`],
        queryLines: [
          'fields @timestamp, services.auth.status as auth_status, services.product-catalog.status as catalog_status, services.order-processing.status as order_status',
          'filter @message like /status/',
          'sort @timestamp desc',
          'limit 20'
        ],
        width: 12,
        height: 6,
      })
    );

    // Artisan Desk Storefront Health
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Artisan Desk Storefront Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Storefront page views and conversions
      new cloudwatch.GraphWidget({
        title: 'Storefront Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Storefront',
            metricName: 'PageViews',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Storefront',
            metricName: 'ProductViews',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Storefront',
            metricName: 'ConversionRate',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Cart operations
      new cloudwatch.GraphWidget({
        title: 'Shopping Cart Operations',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Cart',
            metricName: 'ItemsAdded',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Cart',
            metricName: 'ItemsRemoved',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Cart',
            metricName: 'AbandonmentRate',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Luxury order metrics
      new cloudwatch.GraphWidget({
        title: 'Luxury Order Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/LuxuryOrders',
            metricName: 'OrdersCreated',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/LuxuryOrders',
            metricName: 'AverageOrderValue',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Authentication Service Health
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Authentication Service Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Login success rate
      new cloudwatch.GraphWidget({
        title: 'Login Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'LoginSuccessRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'LoginFailureRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Authentication response times
      new cloudwatch.GraphWidget({
        title: 'Authentication Response Times',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'LoginDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'RegistrationDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // DynamoDB throttling
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttling Events',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'DynamoDBThrottles',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Product Catalog Service Health
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Product Catalog Service Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Request success rate
      new cloudwatch.GraphWidget({
        title: 'Catalog Request Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'SuccessRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'ErrorRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Search performance
      new cloudwatch.GraphWidget({
        title: 'Search Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'SearchResponseTime',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'SearchRequests',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Cache hit rate
      new cloudwatch.GraphWidget({
        title: 'Cache Hit Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'CacheHitRate',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Order Processing Service Health
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Order Processing Service Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Order success rate
      new cloudwatch.GraphWidget({
        title: 'Order Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'OrderSuccessRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'OrderErrorRate',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Order processing times
      new cloudwatch.GraphWidget({
        title: 'Order Processing Times',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'OrderProcessingDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Inventory validation failures
      new cloudwatch.GraphWidget({
        title: 'Inventory Validation Failures',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'InventoryValidationFailures',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Infrastructure Health
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Infrastructure Health',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // EC2 CPU utilization
      new cloudwatch.GraphWidget({
        title: 'EC2 CPU Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // RDS performance
      new cloudwatch.GraphWidget({
        title: 'RDS Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnections',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // ECS performance
      new cloudwatch.GraphWidget({
        title: 'ECS Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'MemoryUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    return dashboard;
  }

  private createPerformanceDashboard(props: MonitoringDashboardsConstructProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'PerformanceDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-performance`,
      defaultInterval: cdk.Duration.hours(1),
    });

    // Performance Overview
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Performance Monitoring & Optimization Opportunities',
        width: 24,
        height: 1,
      })
    );

    // Artisan Desk Performance Metrics
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Artisan Desk Storefront Performance',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Storefront page load times
      new cloudwatch.GraphWidget({
        title: 'Storefront Page Load Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Storefront',
            metricName: 'PageLoadTime',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Average Load Time',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Storefront',
            metricName: 'PageLoadTime',
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
            label: 'P95 Load Time',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Product search performance
      new cloudwatch.GraphWidget({
        title: 'Product Search Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'ArtisanDeskSearchDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Search Duration',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'FilterOperationDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Filter Duration',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Luxury order processing performance
      new cloudwatch.GraphWidget({
        title: 'Luxury Order Processing Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/LuxuryOrders',
            metricName: 'OrderCreationDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Order Creation Time',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/LuxuryOrders',
            metricName: 'InventoryValidationDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Inventory Validation Time',
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Response Time Analysis
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Response Time Analysis',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Service response times comparison
      new cloudwatch.GraphWidget({
        title: 'Service Response Times Comparison',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Auth',
            metricName: 'LoginDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Auth Service',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'ResponseTime',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Catalog Service',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'ResponseTime',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Order Service',
          }),
        ],
        width: 12,
        height: 6,
      }),

      // P95 response times
      new cloudwatch.GraphWidget({
        title: 'P95 Response Times',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'ResponseTime',
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'ResponseTime',
            statistic: 'p95',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Database Performance
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Database Performance Analysis',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Database query performance
      new cloudwatch.GraphWidget({
        title: 'Database Query Performance',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'DatabaseQueryDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Orders',
            metricName: 'MongoDBOperationDuration',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Connection pool utilization
      new cloudwatch.GraphWidget({
        title: 'Database Connection Pool Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'DatabaseConnectionPoolUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Query result counts
      new cloudwatch.GraphWidget({
        title: 'Query Result Counts',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'QueryResultCount',
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Cache Performance
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Cache Performance Analysis',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Cache hit rates by type
      new cloudwatch.GraphWidget({
        title: 'Cache Hit Rates by Type',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'CacheHitRate',
            dimensionsMap: { 'CacheType': 'products' },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Products Cache',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'CacheHitRate',
            dimensionsMap: { 'CacheType': 'search' },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
            label: 'Search Cache',
          }),
        ],
        width: 12,
        height: 6,
      }),

      // Cache operations
      new cloudwatch.GraphWidget({
        title: 'Cache Operations',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'CacheHits',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Catalog',
            metricName: 'CacheMisses',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Performance Markers Log Insights
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Performance Issues & Optimization Opportunities',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Performance markers log insights
      new cloudwatch.LogQueryWidget({
        title: 'Recent Performance Issues',
        logGroupNames: [Object.values(props.logGroups)[0].logGroupName],
        queryLines: [
          'fields @timestamp, service, message, duration_ms',
          'filter performance_marker = true',
          'sort @timestamp desc',
          'limit 20'
        ],
        width: 12,
        height: 6,
      }),

      // Optimization opportunities
      new cloudwatch.LogQueryWidget({
        title: 'Optimization Opportunities',
        logGroupNames: [Object.values(props.logGroups)[0].logGroupName],
        queryLines: [
          'fields @timestamp, service, optimization_type, description',
          'filter optimization_opportunity = true',
          'sort @timestamp desc',
          'limit 20'
        ],
        width: 12,
        height: 6,
      })
    );

    return dashboard;
  }

  private createCostOptimizationDashboard(props: MonitoringDashboardsConstructProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'CostOptimizationDashboard', {
      dashboardName: `${props.projectName}-${props.environment}-cost-optimization`,
      defaultInterval: cdk.Duration.hours(6),
    });

    // Cost Optimization Overview
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Cost Optimization Dashboard\n\nThis dashboard shows resource utilization and identifies optimization opportunities to reduce costs while maintaining performance.',
        width: 24,
        height: 2,
      })
    );

    // Artisan Desk Business Metrics
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Artisan Desk Business Metrics & ROI',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Revenue and conversion metrics
      new cloudwatch.GraphWidget({
        title: 'Revenue & Conversion Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Business',
            metricName: 'DailyRevenue',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
            label: 'Daily Revenue ($)',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Business',
            metricName: 'AverageOrderValue',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Average Order Value ($)',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Business',
            metricName: 'ConversionRate',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Conversion Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Cost per transaction
      new cloudwatch.GraphWidget({
        title: 'Cost Per Transaction',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Business',
            metricName: 'CostPerTransaction',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Cost Per Transaction ($)',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Business',
            metricName: 'InfrastructureCostPerOrder',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Infrastructure Cost Per Order ($)',
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Inventory turnover and efficiency
      new cloudwatch.GraphWidget({
        title: 'Inventory Efficiency',
        left: [
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Inventory',
            metricName: 'TurnoverRate',
            statistic: 'Average',
            period: cdk.Duration.hours(6),
            label: 'Inventory Turnover Rate',
          }),
          new cloudwatch.Metric({
            namespace: 'ShopSmart/Inventory',
            metricName: 'StockoutRate',
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Stockout Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // Lambda Optimization
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Lambda Function Optimization',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Lambda duration vs memory
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (Optimization Opportunity)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Lambda memory utilization
      new cloudwatch.GraphWidget({
        title: 'Lambda Memory Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'MemoryUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // Lambda errors and throttles
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors & Throttles',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Throttles',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // EC2 Optimization
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## EC2 Instance Optimization',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // EC2 CPU utilization (rightsizing opportunity)
      new cloudwatch.GraphWidget({
        title: 'EC2 CPU Utilization (Rightsizing Opportunity)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // EC2 Network utilization
      new cloudwatch.GraphWidget({
        title: 'EC2 Network Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'NetworkIn',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'NetworkOut',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // EC2 Disk utilization
      new cloudwatch.GraphWidget({
        title: 'EC2 Disk I/O',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'DiskReadOps',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'DiskWriteOps',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // RDS Optimization
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## RDS Instance Optimization',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // RDS CPU utilization
      new cloudwatch.GraphWidget({
        title: 'RDS CPU Utilization (Rightsizing Opportunity)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // RDS connections
      new cloudwatch.GraphWidget({
        title: 'RDS Database Connections',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnections',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // RDS IOPS utilization
      new cloudwatch.GraphWidget({
        title: 'RDS IOPS Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ReadIOPS',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'WriteIOPS',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // ECS Optimization
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## ECS Container Optimization',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // ECS CPU utilization
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization (Container Rightsizing)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'CPUUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,

      }),

      // ECS Memory utilization
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization (Container Rightsizing)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'MemoryUtilization',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      }),

      // ECS task count
      new cloudwatch.GraphWidget({
        title: 'ECS Running Tasks',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'RunningTaskCount',
            statistic: 'Average',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 8,
        height: 6,
      })
    );

    // DynamoDB Optimization
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## DynamoDB Optimization',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // DynamoDB consumed capacity
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed vs Provisioned Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 12,
        height: 6,
      }),

      // DynamoDB throttling events
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttling (Capacity Issues)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ThrottledRequests',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Cost Optimization Insights
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Cost Optimization Insights',
        width: 24,
        height: 1,
      })
    );

    dashboard.addWidgets(
      // Optimization opportunities from logs
      new cloudwatch.LogQueryWidget({
        title: 'Cost Optimization Opportunities',
        logGroupNames: [Object.values(props.logGroups)[0].logGroupName],
        queryLines: [
          'fields @timestamp, service, optimization_type, description, potential_savings',
          'filter optimization_opportunity = true',
          'sort @timestamp desc',
          'limit 15'
        ],
        width: 24,
        height: 6,
      })
    );

    return dashboard;
  }
}