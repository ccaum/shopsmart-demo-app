#!/bin/bash

# ShopSmart Database Initialization Script
# This script sets up all databases for the shopping cart demo

set -e

echo "🚀 Initializing ShopSmart databases..."

# Configuration
POSTGRES_HOST=${POSTGRES_HOST:-"localhost"}
POSTGRES_PORT=${POSTGRES_PORT:-"5432"}
POSTGRES_USER=${POSTGRES_USER:-"postgres"}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-"password"}
POSTGRES_DB=${POSTGRES_DB:-"shopsmart_catalog"}

AWS_REGION=${AWS_REGION:-"us-east-1"}
DYNAMODB_ENDPOINT=${DYNAMODB_ENDPOINT:-""}
TABLE_PREFIX=${TABLE_PREFIX:-"shopsmart-dev"}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required tools are installed
check_dependencies() {
    print_status "Checking dependencies..."
    
    if ! command -v psql &> /dev/null; then
        print_error "PostgreSQL client (psql) is not installed"
        exit 1
    fi
    
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed"
        exit 1
    fi
    
    print_status "All dependencies are available"
}

# Initialize PostgreSQL database
init_postgresql() {
    print_status "Setting up PostgreSQL database..."
    
    # Test connection
    if ! PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d postgres -c "SELECT 1;" &> /dev/null; then
        print_error "Cannot connect to PostgreSQL at $POSTGRES_HOST:$POSTGRES_PORT"
        print_error "Please ensure PostgreSQL is running and credentials are correct"
        exit 1
    fi
    
    # Create database if it doesn't exist
    print_status "Creating database '$POSTGRES_DB'..."
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d postgres -c "CREATE DATABASE $POSTGRES_DB;" 2>/dev/null || print_warning "Database '$POSTGRES_DB' already exists"
    
    # Run schema creation
    print_status "Creating database schema..."
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -f "$(dirname "$0")/postgresql/schema.sql"
    
    # Load seed data
    print_status "Loading seed data..."
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -f "$(dirname "$0")/postgresql/seed-data.sql"
    
    # Verify data was loaded
    PRODUCT_COUNT=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -t -c "SELECT COUNT(*) FROM products;")
    print_status "Loaded $PRODUCT_COUNT products into the catalog"
}

# Initialize DynamoDB tables
init_dynamodb() {
    print_status "Setting up DynamoDB tables..."
    
    # Set endpoint if provided (for local DynamoDB)
    ENDPOINT_PARAM=""
    if [ ! -z "$DYNAMODB_ENDPOINT" ]; then
        ENDPOINT_PARAM="--endpoint-url $DYNAMODB_ENDPOINT"
        print_status "Using DynamoDB endpoint: $DYNAMODB_ENDPOINT"
    fi
    
    # Create shopping cart table
    CART_TABLE_NAME="${TABLE_PREFIX}-shopping-carts"
    print_status "Creating DynamoDB table: $CART_TABLE_NAME"
    
    # Update table name in the JSON file
    sed "s/shopsmart-dev-shopping-carts/$CART_TABLE_NAME/g" "$(dirname "$0")/dynamodb/cart-table.json" > /tmp/cart-table-temp.json
    
    # Create table
    if aws dynamodb create-table $ENDPOINT_PARAM --region $AWS_REGION --cli-input-json file:///tmp/cart-table-temp.json &> /dev/null; then
        print_status "Created DynamoDB table: $CART_TABLE_NAME"
        
        # Wait for table to be active
        print_status "Waiting for table to become active..."
        aws dynamodb wait table-exists $ENDPOINT_PARAM --region $AWS_REGION --table-name $CART_TABLE_NAME
        print_status "Table $CART_TABLE_NAME is now active"
    else
        print_warning "Table $CART_TABLE_NAME already exists or creation failed"
    fi
    
    # Clean up temp file
    rm -f /tmp/cart-table-temp.json
}

# Verify setup
verify_setup() {
    print_status "Verifying database setup..."
    
    # Check PostgreSQL
    PRODUCT_COUNT=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -t -c "SELECT COUNT(*) FROM products;" | xargs)
    if [ "$PRODUCT_COUNT" -gt 0 ]; then
        print_status "✅ PostgreSQL: $PRODUCT_COUNT products available"
    else
        print_error "❌ PostgreSQL: No products found"
        exit 1
    fi
    
    # Check DynamoDB
    CART_TABLE_NAME="${TABLE_PREFIX}-shopping-carts"
    ENDPOINT_PARAM=""
    if [ ! -z "$DYNAMODB_ENDPOINT" ]; then
        ENDPOINT_PARAM="--endpoint-url $DYNAMODB_ENDPOINT"
    fi
    
    if aws dynamodb describe-table $ENDPOINT_PARAM --region $AWS_REGION --table-name $CART_TABLE_NAME &> /dev/null; then
        print_status "✅ DynamoDB: Shopping cart table exists"
    else
        print_error "❌ DynamoDB: Shopping cart table not found"
        exit 1
    fi
}

# Main execution
main() {
    echo "=================================================="
    echo "🛒 ShopSmart Database Initialization"
    echo "=================================================="
    
    check_dependencies
    init_postgresql
    init_dynamodb
    verify_setup
    
    echo "=================================================="
    print_status "🎉 Database initialization completed successfully!"
    echo "=================================================="
    echo ""
    echo "Database Details:"
    echo "  PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
    echo "  DynamoDB: ${TABLE_PREFIX}-shopping-carts (Region: $AWS_REGION)"
    echo ""
    echo "Next steps:"
    echo "  1. Deploy Lambda functions for cart management"
    echo "  2. Deploy product catalog service to EC2"
    echo "  3. Deploy order processing service to ECS"
}

# Run main function
main "$@"