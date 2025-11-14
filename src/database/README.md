# ShopSmart Database Setup

This directory contains database schemas, seed data, and initialization scripts for the ShopSmart shopping cart demo application.

## Database Architecture

The application uses three different databases to demonstrate a realistic microservices architecture:

### 1. PostgreSQL (Product Catalog Service)
- **Purpose**: Store product information, categories, and inventory
- **Location**: RDS PostgreSQL instance
- **Schema**: `postgresql/schema.sql`
- **Seed Data**: `postgresql/seed-data.sql`

### 2. DynamoDB (Authentication & Cart Service)
- **Purpose**: Store user sessions and shopping cart data
- **Location**: AWS DynamoDB
- **Schema**: `dynamodb/cart-table.json`
- **Tables**: 
  - `users` (existing from auth service)
  - `sessions` (existing from auth service)
  - `shopping-carts` (new for cart functionality)

### 3. MongoDB (Order Processing Service)
- **Purpose**: Store order history and transaction data
- **Location**: MongoDB container in ECS
- **Schema**: `mongodb/init-orders.js`
- **Collections**: `orders`, `order_analytics` (view)

## Quick Setup

### Prerequisites
- PostgreSQL client (`psql`)
- AWS CLI configured with appropriate permissions
- MongoDB client (for manual setup)

### Automated Setup
```bash
# Copy configuration template
cp database/config.env.example database/config.env

# Edit configuration with your values
nano database/config.env

# Run initialization script
./database/init-databases.sh
```

### Manual Setup

#### PostgreSQL Setup
```bash
# Connect to PostgreSQL
psql -h your-rds-endpoint -U postgres -d postgres

# Create database
CREATE DATABASE shopsmart_catalog;

# Switch to database
\c shopsmart_catalog;

# Run schema and seed scripts
\i database/postgresql/schema.sql
\i database/postgresql/seed-data.sql
```

#### DynamoDB Setup
```bash
# Create shopping cart table
aws dynamodb create-table --cli-input-json file://database/dynamodb/cart-table.json

# Wait for table to be active
aws dynamodb wait table-exists --table-name shopsmart-dev-shopping-carts
```

#### MongoDB Setup
```bash
# Connect to MongoDB
mongo mongodb://your-mongodb-host:27017

# Run initialization script
load('database/mongodb/init-orders.js')
```

## Database Schemas

### Products Table (PostgreSQL)
```sql
CREATE TABLE products (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    inventory_count INTEGER DEFAULT 0,
    image_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### Shopping Cart Items (DynamoDB)
```json
{
  "cartId": "userId#productId",
  "userId": "uuid",
  "productId": "uuid",
  "quantity": 2,
  "addedAt": "2024-01-15T10:30:00Z",
  "ttl": 1705392600
}
```

### Orders Collection (MongoDB)
```javascript
{
  "_id": ObjectId,
  "orderId": "uuid",
  "userId": "uuid",
  "items": [
    {
      "productId": "uuid",
      "name": "Product Name",
      "price": NumberDecimal("29.99"),
      "quantity": 2
    }
  ],
  "totalAmount": NumberDecimal("59.98"),
  "shippingAddress": { ... },
  "status": "pending|processing|shipped|delivered",
  "createdAt": ISODate,
  "updatedAt": ISODate
}
```

## Seed Data

The initialization scripts populate the databases with realistic test data:

- **Products**: 50+ items across 6 categories (Electronics, Clothing, Home & Garden, Books, Sports & Outdoors)
- **Price Range**: $12.95 to $2,499.00 to test various scenarios
- **Inventory Levels**: Varied stock levels to test low inventory and out-of-stock scenarios
- **Sample Orders**: Pre-populated order history for testing

## Performance Considerations

### PostgreSQL Indexes
- Category-based queries: `idx_products_category`
- Name searches: `idx_products_name`
- Full-text search: `idx_products_search`
- Price filtering: `idx_products_price`
- Inventory checks: `idx_products_inventory`

### DynamoDB Design
- Partition key: `cartId` (userId#productId for item-level operations)
- GSI: `UserIdIndex` for retrieving all cart items for a user
- TTL: Automatic cleanup of abandoned carts after 30 days

### MongoDB Indexes
- Order lookup: `orderId` (unique)
- User history: `userId`, `createdAt`
- Status filtering: `status`
- Compound queries: `userId + status + createdAt`

## Environment Configuration

Create a `config.env` file based on `config.env.example`:

```bash
# PostgreSQL (RDS)
POSTGRES_HOST=your-rds-endpoint.amazonaws.com
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-secure-password
POSTGRES_DB=shopsmart_catalog

# AWS
AWS_REGION=us-east-1
TABLE_PREFIX=shopsmart-dev

# MongoDB (ECS)
MONGODB_HOST=your-ecs-service-endpoint
MONGODB_PORT=27017
```

## Troubleshooting

### Common Issues

1. **PostgreSQL Connection Failed**
   - Check RDS security groups allow connections
   - Verify endpoint and credentials
   - Ensure database exists

2. **DynamoDB Table Creation Failed**
   - Check AWS credentials and permissions
   - Verify region configuration
   - Check if table already exists

3. **MongoDB Connection Issues**
   - Ensure ECS service is running
   - Check security group rules
   - Verify MongoDB container health

### Verification Commands

```bash
# Check PostgreSQL
psql -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT COUNT(*) FROM products;"

# Check DynamoDB
aws dynamodb describe-table --table-name shopsmart-dev-shopping-carts

# Check MongoDB
mongo $MONGODB_HOST:$MONGODB_PORT/shopsmart_orders --eval "db.orders.count()"
```

## Next Steps

After database setup is complete:

1. Deploy enhanced Lambda functions for cart management
2. Deploy product catalog web application to EC2
3. Deploy order processing service to ECS
4. Configure cross-service communication
5. Set up monitoring and logging

## Security Notes

- Use strong passwords for all database connections
- Enable encryption at rest for all databases
- Configure VPC security groups to restrict access
- Use IAM roles for AWS service authentication
- Regularly rotate database credentials