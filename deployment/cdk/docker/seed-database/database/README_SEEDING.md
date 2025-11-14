# Database Seeding for Artisan Desk Storefront

This directory contains scripts and tools for seeding the database with artisan desk products and creating demo user accounts for the ShopSmart Artisan Desk Storefront.

## Overview

The seeding process consists of three main components:

1. **PostgreSQL Schema Migration** - Extends the Product Catalog database with artisan desk specific columns
2. **Product Data Seeding** - Generates 50 unique artisanal desk products with luxury pricing
3. **Demo User Creation** - Creates a demo user account in the User Auth service DynamoDB tables

## Quick Start

### Prerequisites

- PostgreSQL client (`psql`)
- Python 3.x with `pip3`
- AWS CLI configured with appropriate credentials
- Access to the ShopSmart databases (PostgreSQL and DynamoDB)

### Environment Variables

```bash
# PostgreSQL Configuration
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=shopsmart_catalog
export DB_USER=postgres
export DB_PASSWORD=password

# AWS/DynamoDB Configuration
export AWS_REGION=us-east-1
export PROJECT_NAME=shopsmart
export ENVIRONMENT=dev
```

### Run Complete Seeding

```bash
# Run all seeding steps
./database/seed_all.sh

# Run with options
./database/seed_all.sh --clear --force
```

## Individual Components

### 1. PostgreSQL Schema Migration

Extends the products table with artisan desk specific columns:

```bash
cd database/postgresql
./migrate.sh up 001      # Apply migration
./migrate.sh status      # Check status
./migrate.sh down 001    # Rollback (if needed)
```

**New Columns Added:**
- `material` - Wood type (e.g., "Walnut Burl", "Ebony")
- `style` - Design style (e.g., "Mid-Century Modern", "Japanese Minimalist")
- `crafting_time_months` - Time to craft in months
- `artisan_name` - Name of the craftsperson
- `authenticity_certificate` - Certificate number

### 2. Artisan Desk Product Seeding

Generates 50 unique luxury desk products:

```bash
cd database/postgresql
python3 seed_artisan_desks.py           # Create products
python3 seed_artisan_desks.py --clear   # Clear existing first
```

**Product Features:**
- Pricing: $5,000 - $500,000
- 20 unique materials (exotic woods)
- 15 unique styles (design aesthetics)
- 50 unique artisan names
- Realistic descriptions and specifications
- Authenticity certificates

### 3. Demo User Creation

Creates a demo user account for testing:

```bash
cd database/dynamodb
python3 seed_demo_user.py         # Create demo user
python3 seed_demo_user.py --force  # Force recreate
```

**Demo User Details:**
- Email: `demo@artisandesks.com`
- Password: `demo`
- Name: `Demo User`
- Includes sample cart items
- Complete user profile and preferences

## File Structure

```
database/
├── seed_all.sh                           # Main orchestration script
├── README_SEEDING.md                     # This documentation
├── postgresql/
│   ├── migrate.sh                        # Migration runner
│   ├── requirements.txt                  # Python dependencies
│   ├── seed_artisan_desks.py            # Product seeding script
│   └── migrations/
│       ├── 001_add_artisan_desk_columns.sql
│       └── 001_add_artisan_desk_columns_rollback.sql
└── dynamodb/
    ├── requirements.txt                  # Python dependencies
    └── seed_demo_user.py                # Demo user creation script
```

## Command Line Options

### seed_all.sh Options

```bash
--skip-deps       # Skip dependency checking and installation
--skip-migration  # Skip PostgreSQL schema migration
--skip-products   # Skip artisan desk product seeding
--skip-user       # Skip demo user creation
--clear           # Clear existing products before seeding
--force           # Force recreate demo user if exists
--help            # Show help message
```

### Examples

```bash
# Full seeding with cleanup
./database/seed_all.sh --clear --force

# Skip dependencies (if already installed)
./database/seed_all.sh --skip-deps

# Only run product seeding
./database/seed_all.sh --skip-migration --skip-user

# Only create demo user
./database/seed_all.sh --skip-migration --skip-products
```

## Verification

### PostgreSQL Products

```sql
-- Count artisan desk products
SELECT COUNT(*) FROM products WHERE category = 'Artisanal Desks';

-- View sample products
SELECT name, price, material, style, artisan_name 
FROM products 
WHERE category = 'Artisanal Desks' 
LIMIT 5;

-- Price statistics
SELECT 
    MIN(price) as min_price,
    MAX(price) as max_price,
    AVG(price) as avg_price
FROM products 
WHERE category = 'Artisanal Desks';
```

### DynamoDB Demo User

```bash
# Using AWS CLI
aws dynamodb get-item \
    --table-name shopsmart-dev-users \
    --key '{"userId": {"S": "USER_ID_HERE"}}'

# Check cart items
aws dynamodb query \
    --table-name shopsmart-dev-carts \
    --index-name UserIdIndex \
    --key-condition-expression "userId = :userId" \
    --expression-attribute-values '{":userId": {"S": "USER_ID_HERE"}}'
```

## Troubleshooting

### Common Issues

1. **PostgreSQL Connection Failed**
   ```bash
   # Check if PostgreSQL is running
   pg_isready -h localhost -p 5432
   
   # Verify credentials
   psql -h localhost -p 5432 -U postgres -d shopsmart_catalog -c "SELECT 1;"
   ```

2. **DynamoDB Tables Not Found**
   ```bash
   # List tables
   aws dynamodb list-tables
   
   # Check if CDK stack is deployed
   aws cloudformation describe-stacks --stack-name YourStackName
   ```

3. **Python Dependencies Missing**
   ```bash
   # Install manually
   pip3 install psycopg2-binary boto3 --user
   ```

4. **AWS Credentials Not Configured**
   ```bash
   # Configure AWS CLI
   aws configure
   
   # Or set environment variables
   export AWS_ACCESS_KEY_ID=your_key
   export AWS_SECRET_ACCESS_KEY=your_secret
   ```

### Migration Rollback

If you need to rollback the schema changes:

```bash
cd database/postgresql
./migrate.sh down 001
```

This will remove all artisan desk columns and restore the original schema.

## Integration with CDK

The seeding scripts are designed to work with the existing CDK infrastructure:

1. **Deploy CDK Stack First** - Ensures DynamoDB tables exist
2. **Run Database Seeding** - Populates data
3. **Deploy Frontend** - Uses seeded data

```bash
# Typical workflow
cdk deploy                    # Deploy infrastructure
./database/seed_all.sh       # Seed databases
# Deploy frontend application
```

## Security Notes

- Demo user uses simple SHA256 hashing (matches Lambda implementation)
- In production, use proper password hashing (bcrypt, Argon2)
- Demo user should be removed in production environments
- Ensure proper AWS IAM permissions for DynamoDB access

## Performance Considerations

- Product seeding generates unique combinations to avoid duplicates
- Uses batch operations where possible for DynamoDB
- Includes proper indexes for filtering performance
- Cart items have TTL set to 30 days (matches Lambda implementation)

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Verify environment variables are set correctly
3. Ensure all prerequisites are installed
4. Check AWS credentials and permissions