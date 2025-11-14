# Order Processing Service Deployment

This directory contains deployment configurations and scripts for the Order Processing Service.

## Local Development

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for local development without Docker)

### Quick Start with Docker Compose

1. **Start all services:**
   ```bash
   docker-compose up -d
   ```

2. **View logs:**
   ```bash
   docker-compose logs -f order-processing
   ```

3. **Stop services:**
   ```bash
   docker-compose down
   ```

4. **Start with debugging tools:**
   ```bash
   docker-compose --profile debug up -d
   ```

### Local Development without Docker

1. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start MongoDB (using Docker):**
   ```bash
   docker run -d --name mongodb -p 27017:27017 mongo:7.0
   ```

4. **Run the application:**
   ```bash
   uvicorn app:app --reload --host 0.0.0.0 --port 8000
   ```

## Production Deployment

### ECS Deployment

The service is designed to run on AWS ECS with the following architecture:
- **Container**: FastAPI application in Docker container
- **Database**: MongoDB (can be MongoDB Atlas or self-hosted)
- **Load Balancer**: Application Load Balancer for high availability
- **Logging**: CloudWatch Logs with structured JSON logging
- **Monitoring**: CloudWatch custom metrics

### Environment Variables

Required environment variables for production:

```bash
# Application
APP_NAME=order-processing-service
DEBUG=false
PORT=8000

# Database
MONGODB_URL=mongodb://your-mongodb-cluster/orders

# External Services
PRODUCT_SERVICE_URL=http://your-product-service-alb
AUTH_SERVICE_URL=https://your-api-gateway/auth

# AWS
AWS_REGION=us-east-1
CLOUDWATCH_LOG_GROUP=/aws/ecs/order-processing
```

### Health Checks

The service provides multiple health check endpoints:

- `GET /health` - Basic health check
- `GET /health/ready` - Readiness check with dependency validation

### Resource Configuration

Recommended ECS task configuration:
- **CPU**: 1024 units (1 vCPU)
- **Memory**: 2048 MB (2 GB)
- **Container CPU**: 512 units
- **Container Memory**: 1024 MB

### Scaling Configuration

- **Minimum tasks**: 2
- **Maximum tasks**: 10
- **Target CPU utilization**: 70%
- **Target memory utilization**: 80%

## API Documentation

Once running, API documentation is available at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Monitoring

### CloudWatch Metrics

The service emits custom metrics:
- `RequestCount` - Number of requests per endpoint
- `ResponseTime` - Response time in milliseconds
- `ErrorRate` - Error rate by error type
- `HTTPStatusCode` - HTTP status code distribution

### Logs

Structured JSON logs include:
- Correlation IDs for request tracing
- Performance metrics
- Error details with context
- Cross-service communication logs

## Troubleshooting

### Common Issues

1. **MongoDB Connection Failed**
   - Check MONGODB_URL environment variable
   - Verify MongoDB is running and accessible
   - Check network connectivity

2. **External Service Communication Errors**
   - Verify PRODUCT_SERVICE_URL and AUTH_SERVICE_URL
   - Check network policies and security groups
   - Review service discovery configuration

3. **High Memory Usage**
   - Monitor MongoDB connection pool size
   - Check for memory leaks in HTTP client connections
   - Review container resource limits

### Debug Mode

Enable debug mode for detailed logging:
```bash
DEBUG=true LOG_LEVEL=DEBUG docker-compose up
```