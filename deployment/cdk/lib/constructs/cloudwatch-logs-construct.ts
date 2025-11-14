import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CloudWatchLogsConstructProps {
  projectName: string;
  environment: string;
  logRetentionDays?: logs.RetentionDays;
}

export class CloudWatchLogsConstruct extends Construct {
  public readonly logGroups: { [key: string]: logs.LogGroup } = {};

  constructor(scope: Construct, id: string, props: CloudWatchLogsConstructProps) {
    super(scope, id);

    const retentionDays = props.logRetentionDays || logs.RetentionDays.ONE_WEEK;

    // Authentication Service Log Groups (Lambda functions)
    this.createAuthServiceLogGroups(props, retentionDays);

    // Product Catalog Service Log Groups (EC2)
    this.createCatalogServiceLogGroups(props, retentionDays);

    // Order Processing Service Log Groups (ECS)
    this.createOrderServiceLogGroups(props, retentionDays);

    // Infrastructure Log Groups
    this.createInfrastructureLogGroups(props, retentionDays);

    // Create log insights queries
    this.createLogInsightsQueries(props);
  }

  private createAuthServiceLogGroups(props: CloudWatchLogsConstructProps, retention: logs.RetentionDays) {
    // Lambda function log groups
    const lambdaFunctions = [
      'login', 'register', 'validate-session', 
      'get-cart', 'add-to-cart', 'update-cart-item', 
      'remove-cart-item', 'clear-cart'
    ];

    lambdaFunctions.forEach(functionName => {
      this.logGroups[`auth-${functionName}`] = new logs.LogGroup(this, `Auth${this.toPascalCase(functionName)}LogGroup`, {
        logGroupName: `/aws/lambda/${props.projectName}-${props.environment}-${functionName}`,
        retention: retention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    });

    // API Gateway log group
    this.logGroups['auth-api-gateway'] = new logs.LogGroup(this, 'AuthAPIGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${props.projectName}-${props.environment}-auth-api`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createCatalogServiceLogGroups(props: CloudWatchLogsConstructProps, retention: logs.RetentionDays) {
    // Application log group
    this.logGroups['catalog-application'] = new logs.LogGroup(this, 'CatalogApplicationLogGroup', {
      logGroupName: `/aws/ec2/${props.projectName}-${props.environment}-catalog-app`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Performance log group
    this.logGroups['catalog-performance'] = new logs.LogGroup(this, 'CatalogPerformanceLogGroup', {
      logGroupName: `/aws/ec2/${props.projectName}-${props.environment}-catalog-performance`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cache operations log group
    this.logGroups['catalog-cache'] = new logs.LogGroup(this, 'CatalogCacheLogGroup', {
      logGroupName: `/aws/ec2/${props.projectName}-${props.environment}-catalog-cache`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Database operations log group
    this.logGroups['catalog-database'] = new logs.LogGroup(this, 'CatalogDatabaseLogGroup', {
      logGroupName: `/aws/ec2/${props.projectName}-${props.environment}-catalog-database`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createOrderServiceLogGroups(props: CloudWatchLogsConstructProps, retention: logs.RetentionDays) {
    // ECS application log group
    this.logGroups['orders-application'] = new logs.LogGroup(this, 'OrdersApplicationLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-orders-app`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Order processing log group
    this.logGroups['orders-processing'] = new logs.LogGroup(this, 'OrdersProcessingLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-orders-processing`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Service communication log group
    this.logGroups['orders-service-communication'] = new logs.LogGroup(this, 'OrdersServiceCommunicationLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-orders-service-comm`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // MongoDB operations log group
    this.logGroups['orders-mongodb'] = new logs.LogGroup(this, 'OrdersMongoDBLogGroup', {
      logGroupName: `/aws/ecs/${props.projectName}-${props.environment}-orders-mongodb`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createInfrastructureLogGroups(props: CloudWatchLogsConstructProps, retention: logs.RetentionDays) {
    // VPC Flow Logs
    this.logGroups['vpc-flow-logs'] = new logs.LogGroup(this, 'VPCFlowLogsGroup', {
      logGroupName: `/aws/vpc/${props.projectName}-${props.environment}-flow-logs`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Load Balancer logs
    this.logGroups['alb-access-logs'] = new logs.LogGroup(this, 'ALBAccessLogsGroup', {
      logGroupName: `/aws/elasticloadbalancing/${props.projectName}-${props.environment}-alb`,
      retention: retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudTrail logs
    this.logGroups['cloudtrail'] = new logs.LogGroup(this, 'CloudTrailLogGroup', {
      logGroupName: `/aws/cloudtrail/${props.projectName}-${props.environment}`,
      retention: logs.RetentionDays.ONE_MONTH, // Keep CloudTrail logs longer
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createLogInsightsQueries(props: CloudWatchLogsConstructProps) {
    // Performance analysis query
    new logs.CfnQueryDefinition(this, 'PerformanceAnalysisQuery', {
      name: `${props.projectName}-${props.environment}-performance-analysis`,
      logGroupNames: Object.values(this.logGroups).map(lg => lg.logGroupName),
      queryString: `
        fields @timestamp, service, correlation_id, duration_ms, performance_marker
        | filter performance_marker = true
        | sort @timestamp desc
        | limit 100
      `,
    });

    // Error analysis query
    new logs.CfnQueryDefinition(this, 'ErrorAnalysisQuery', {
      name: `${props.projectName}-${props.environment}-error-analysis`,
      logGroupNames: Object.values(this.logGroups).map(lg => lg.logGroupName),
      queryString: `
        fields @timestamp, service, correlation_id, level, message, error_type
        | filter level = "ERROR" or level = "WARNING"
        | sort @timestamp desc
        | limit 100
      `,
    });

    // Correlation ID tracing query
    new logs.CfnQueryDefinition(this, 'CorrelationTraceQuery', {
      name: `${props.projectName}-${props.environment}-correlation-trace`,
      logGroupNames: Object.values(this.logGroups).map(lg => lg.logGroupName),
      queryString: `
        fields @timestamp, service, correlation_id, message, duration_ms
        | filter correlation_id like /CORRELATION_ID_HERE/
        | sort @timestamp asc
      `,
    });

    // Optimization opportunities query
    new logs.CfnQueryDefinition(this, 'OptimizationOpportunitiesQuery', {
      name: `${props.projectName}-${props.environment}-optimization-opportunities`,
      logGroupNames: Object.values(this.logGroups).map(lg => lg.logGroupName),
      queryString: `
        fields @timestamp, service, optimization_type, description, potential_improvement
        | filter optimization_opportunity = true
        | sort @timestamp desc
        | limit 50
      `,
    });

    // Service communication analysis query
    new logs.CfnQueryDefinition(this, 'ServiceCommunicationQuery', {
      name: `${props.projectName}-${props.environment}-service-communication`,
      logGroupNames: Object.values(this.logGroups).map(lg => lg.logGroupName),
      queryString: `
        fields @timestamp, service, correlation_id, operation, duration_ms, success
        | filter event_type = "service_call" or operation like /service/
        | sort @timestamp desc
        | limit 100
      `,
    });

    // Cache performance query
    new logs.CfnQueryDefinition(this, 'CachePerformanceQuery', {
      name: `${props.projectName}-${props.environment}-cache-performance`,
      logGroupNames: [this.logGroups['catalog-cache'].logGroupName],
      queryString: `
        fields @timestamp, cache_type, cache_hit, operation, duration_ms
        | filter cache_hit = true or cache_hit = false
        | stats count() by cache_hit, cache_type
      `,
    });

    // Database performance query
    new logs.CfnQueryDefinition(this, 'DatabasePerformanceQuery', {
      name: `${props.projectName}-${props.environment}-database-performance`,
      logGroupNames: [
        this.logGroups['catalog-database'].logGroupName,
        this.logGroups['orders-mongodb'].logGroupName
      ],
      queryString: `
        fields @timestamp, query_type, duration_ms, result_count, optimization_opportunity
        | filter duration_ms > 500
        | sort duration_ms desc
        | limit 50
      `,
    });

    // Authentication metrics query
    new logs.CfnQueryDefinition(this, 'AuthMetricsQuery', {
      name: `${props.projectName}-${props.environment}-auth-metrics`,
      logGroupNames: Object.keys(this.logGroups)
        .filter(key => key.startsWith('auth-'))
        .map(key => this.logGroups[key].logGroupName),
      queryString: `
        fields @timestamp, event_type, success, duration_ms, failure_reason
        | filter event_type in ["authentication", "registration", "session_validation", "cart_operation"]
        | stats count() by event_type, success
      `,
    });
  }

  private toPascalCase(str: string): string {
    return str.split('-').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
  }

  /**
   * Create IAM role for CloudWatch Logs access
   */
  public createLogsAccessRole(): iam.Role {
    const role = new iam.Role(this, 'CloudWatchLogsAccessRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
      ],
    });

    // Add custom policy for log group access
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
      ],
      resources: Object.values(this.logGroups).map(lg => lg.logGroupArn),
    }));

    return role;
  }
}