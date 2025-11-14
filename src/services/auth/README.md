# User Authentication Service

Enhanced User Authentication Service with customer profiles and shopping cart management for the ShopSmart Artisan Desk Storefront.

## Overview

This service provides comprehensive user authentication, customer profile management, and shopping cart functionality. It's designed to support the luxury artisan desk e-commerce experience with enhanced customer data models and persistent cart storage.

## Features

### Authentication
- User registration with enhanced customer profiles
- Secure login with session management
- Session validation and management
- Password hashing and security

### Customer Profiles
- Enhanced customer data models with preferences
- Profile management (create, read, update)
- Customer preferences for personalized experience
- Address management for shipping and billing

### Shopping Cart Management
- Persistent cart storage in DynamoDB
- Add, update, and remove cart items
- Cart retrieval and clearing
- Automatic cart expiration (TTL)

### Monitoring & Observability
- Structured logging with request tracing
- Custom metrics collection for Dynatrace
- Performance monitoring and error tracking
- Security event logging

## API Endpoints

### Authentication Endpoints

#### Register User
```http
POST /auth/register
Content-Type: application/json

{
  "email": "customer@example.com",
  "password": "securepassword",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+1234567890",
  "favoriteStyles": ["Modern", "Minimalist"],
  "priceRange": {"min": 5000, "max": 50000},
  "materialPreferences": ["Oak", "Walnut"],
  "newsletterSubscribed": true
}
```

#### Login User
```http
POST /auth/login
Content-Type: application/json

{
  "email": "customer@example.com",
  "password": "securepassword"
}
```

#### Validate Session
```http
GET /auth/validate/{sessionId}
```

### Profile Management Endpoints

#### Get User Profile
```http
GET /auth/profile/{userId}
```

#### Update User Profile
```http
PUT /auth/profile/{userId}
Content-Type: application/json

{
  "profile": {
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+1234567890"
  },
  "preferences": {
    "favoriteStyles": ["Modern", "Industrial"],
    "priceRange": {"min": 10000, "max": 100000}
  }
}
```

### Shopping Cart Endpoints

#### Get Cart
```http
GET /auth/cart/{userId}
```

#### Add/Update Cart Item
```http
PUT /auth/cart/{userId}
Content-Type: application/json

{
  "productId": "desk-001",
  "name": "Artisan Oak Desk",
  "price": 15000,
  "quantity": 1
}
```

#### Update Cart Item Quantity
```http
PUT /auth/cart/{userId}/{productId}
Content-Type: application/json

{
  "quantity": 2
}
```

#### Remove Cart Item
```http
DELETE /auth/cart/{userId}/{productId}
```

#### Clear Cart
```http
DELETE /auth/cart/{userId}
```

### Health Check
```http
GET /health
```

## Data Models

### Customer Model
Enhanced customer model with profile and preferences:
- User ID, username, email
- Password hash (secure)
- Customer profile (name, phone, addresses)
- Customer preferences (styles, price range, materials)
- Creation and login timestamps

### Shopping Cart Model
Persistent shopping cart with:
- Cart items with product details
- Quantity and pricing information
- Automatic expiration (TTL)
- User association

### Session Model
Secure session management:
- Session ID and user association
- Automatic expiration
- Creation timestamps

## Configuration

### Environment Variables

```bash
# Flask Configuration
FLASK_ENV=development
DEBUG=True
SECRET_KEY=your-secret-key-here
PORT=8002

# AWS Configuration
AWS_REGION=us-east-1
USER_TABLE_NAME=shopsmart-dev-users
SESSION_TABLE_NAME=shopsmart-dev-sessions
CART_TABLE_NAME=shopsmart-dev-carts

# Security Configuration
PASSWORD_MIN_LENGTH=8
SESSION_TIMEOUT_HOURS=24
CART_TTL_DAYS=30

# Monitoring Configuration
DYNATRACE_ENABLED=True
METRICS_ENABLED=True
LOG_LEVEL=INFO
```

## Deployment

### Local Development

1. **Setup Environment**
   ```bash
   cd services/auth
   cp .env.example .env
   # Edit .env with your configuration
   ```

2. **Install Dependencies**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Run Service**
   ```bash
   python app.py
   ```

### Production Deployment

Use the deployment script:
```bash
./deploy/deploy.sh deploy
```

Available commands:
- `deploy` - Full deployment
- `start` - Start service
- `stop` - Stop service
- `restart` - Restart service
- `status` - Show status
- `validate` - Validate deployment

### Docker Deployment

```bash
# Build image
docker build -t user-auth-service .

# Run container
docker run -d \
  --name user-auth \
  -p 8002:8002 \
  --env-file .env \
  user-auth-service
```

## Database Schema

### DynamoDB Tables

#### Users Table
- **Partition Key**: `userId` (String)
- **GSI**: `EmailIndex` on `email`
- **Attributes**: username, email, passwordHash, profile, preferences, timestamps

#### Sessions Table
- **Partition Key**: `sessionId` (String)
- **TTL**: Automatic expiration
- **Attributes**: userId, createdAt, ttl

#### Shopping Carts Table
- **Partition Key**: `cartId` (String) - Format: `{userId}#{productId}`
- **GSI**: `UserIdIndex` on `userId`
- **TTL**: Automatic expiration (30 days)
- **Attributes**: userId, productId, name, price, quantity, timestamps

## Security Features

### Password Security
- SHA256 hashing (upgrade to bcrypt recommended for production)
- Minimum password length enforcement
- Password strength validation

### Session Security
- Secure session ID generation
- Automatic session expiration
- Session validation on protected endpoints

### Data Protection
- Input validation and sanitization
- SQL injection prevention
- XSS protection through proper encoding

### Rate Limiting
- Configurable rate limiting per endpoint
- Protection against brute force attacks
- Account lockout mechanisms

## Monitoring & Observability

### Structured Logging
- Request/response logging with correlation IDs
- Security event logging
- Database operation logging
- Error tracking and correlation

### Custom Metrics
- Authentication success/failure rates
- Cart operation metrics
- User activity tracking
- Performance metrics (response times, throughput)

### Dynatrace Integration
- Automatic error tracking
- Performance monitoring
- User journey analytics
- Custom business metrics

## Testing

### Unit Tests
```bash
# Run unit tests
pytest tests/unit/

# Run with coverage
pytest --cov=. tests/unit/
```

### Integration Tests
```bash
# Run integration tests
pytest tests/integration/
```

### Load Testing
```bash
# Example load test with curl
for i in {1..100}; do
  curl -X GET http://localhost:8002/health &
done
wait
```

## Troubleshooting

### Common Issues

1. **Service won't start**
   - Check port availability: `lsof -i :8002`
   - Verify environment variables
   - Check DynamoDB table permissions

2. **Authentication failures**
   - Verify DynamoDB table configuration
   - Check AWS credentials and permissions
   - Review security group settings

3. **Cart operations failing**
   - Verify cart table exists and is accessible
   - Check TTL configuration
   - Review GSI configuration

### Logs
- Application logs: `user-auth.log`
- Error logs: Check CloudWatch Logs
- Access logs: Structured JSON format

### Health Checks
- Health endpoint: `GET /health`
- Database connectivity: Included in health check
- Service dependencies: Monitored automatically

## Development

### Code Structure
```
services/auth/
├── app.py                 # Main Flask application
├── models.py             # Data models
├── config.py             # Configuration management
├── requirements.txt      # Python dependencies
├── Dockerfile           # Container configuration
├── .env.example         # Environment template
├── middleware/          # Custom middleware
│   ├── logging_middleware.py
│   └── metrics_middleware.py
└── deploy/              # Deployment scripts
    └── deploy.sh
```

### Adding New Features
1. Update models in `models.py`
2. Add endpoints in `app.py`
3. Update configuration in `config.py`
4. Add tests for new functionality
5. Update documentation

### Code Quality
- Use `black` for code formatting
- Use `flake8` for linting
- Use `mypy` for type checking
- Follow PEP 8 style guidelines

## Contributing

1. Follow the existing code structure
2. Add comprehensive tests for new features
3. Update documentation
4. Ensure security best practices
5. Add appropriate logging and metrics