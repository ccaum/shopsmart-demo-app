# Product Catalog Service Deployment

This directory contains deployment scripts and configurations for the Product Catalog Service on EC2.

## Files Overview

- `install.sh` - Installation script for setting up the service on EC2 instances
- `startup.sh` - Startup script executed during instance launch via user data
- `health-check.sh` - Health check script for load balancer and monitoring
- `deploy.sh` - Deployment script for rolling updates via Auto Scaling Group
- `cloudwatch-config.json` - CloudWatch agent configuration for metrics and logs

## Deployment Process

### 1. Initial Setup

The service is deployed using AWS CDK infrastructure which creates:
- Auto Scaling Group with EC2 instances
- Application Load Balancer with health checks
- RDS PostgreSQL database
- ElastiCache Redis cluster
- CloudWatch monitoring and logging

### 2. Application Deployment

```bash
# Set environment variables
export DEPLOYMENT_S3_BUCKET="your-deployment-bucket"
export ASG_NAME="ShopSmart-ProductCatalog-ASG"
export AWS_REGION="us-east-1"

# Run deployment
cd services/product-catalog
./deploy/deploy.sh
```

### 3. Manual Installation (for testing)

```bash
# Copy application files to /tmp/product-catalog/
# Then run:
sudo ./deploy/install.sh
```

## Configuration

### Environment Variables

The service uses the following environment variables:

- `DATABASE_HOST` - PostgreSQL database hostname
- `DATABASE_PORT` - Database port (default: 5432)
- `DATABASE_NAME` - Database name (default: shopsmart_catalog)
- `DATABASE_USER` - Database username
- `DATABASE_PASSWORD` - Database password
- `REDIS_HOST` - Redis hostname
- `REDIS_PORT` - Redis port (default: 6379)
- `AWS_REGION` - AWS region
- `SECRETS_MANAGER_DB_SECRET` - Secrets Manager secret name for DB credentials
- `CLOUDWATCH_ENABLED` - Enable CloudWatch metrics (default: true)

### AWS Systems Manager Parameters

The startup script loads configuration from SSM Parameter Store:

- `/shopsmart/product-catalog/database-host`
- `/shopsmart/product-catalog/redis-host`

### Secrets Manager

Database credentials are stored in AWS Secrets Manager and automatically loaded by the application.

## Health Checks

The service provides a health check endpoint at `/health` that:
- Verifies database connectivity
- Verifies Redis connectivity
- Returns JSON status response

Load balancer health checks use this endpoint with:
- Path: `/health`
- Port: 80
- Healthy threshold: 3
- Unhealthy threshold: 3
- Timeout: 5 seconds
- Interval: 30 seconds

## Monitoring

### CloudWatch Metrics

The service emits custom metrics to CloudWatch:
- Request count and response times
- Success/error rates
- Database and cache performance metrics

### CloudWatch Logs

Application logs are sent to CloudWatch Log Groups:
- `/aws/ec2/product-catalog/app` - Application logs
- `/aws/ec2/product-catalog/access` - Access logs
- `/aws/ec2/product-catalog/startup` - Startup logs

### System Metrics

CloudWatch agent collects system metrics:
- CPU utilization
- Memory usage
- Disk usage and I/O
- Network statistics

## Troubleshooting

### Check Service Status

```bash
sudo systemctl status product-catalog
```

### View Application Logs

```bash
sudo journalctl -u product-catalog -f
```

### View Startup Logs

```bash
sudo tail -f /var/log/product-catalog-startup.log
```

### Manual Health Check

```bash
./deploy/health-check.sh
```

### Check Database Connectivity

```bash
# From EC2 instance
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "SELECT 1;"
```

### Check Redis Connectivity

```bash
# From EC2 instance
redis-cli -h $REDIS_HOST ping
```

## Rolling Deployments

The deployment script performs rolling updates:

1. Packages the application and uploads to S3
2. Updates the launch template with new user data
3. Starts an instance refresh with 50% minimum healthy percentage
4. Waits for all instances to be replaced
5. Verifies deployment by checking target group health

## Security

The service runs with security hardening:
- Dedicated service user with minimal privileges
- systemd security settings (NoNewPrivileges, PrivateTmp, etc.)
- Read-only file system except for logs and working directory
- Network security groups restrict access to necessary ports only

## Performance Optimization

The service is configured for demonstration of optimization opportunities:
- Deliberately oversized EC2 instances to show rightsizing potential
- Multiple worker processes for load handling
- Redis caching with configurable TTL values
- Database connection pooling
- CloudWatch metrics for performance monitoring