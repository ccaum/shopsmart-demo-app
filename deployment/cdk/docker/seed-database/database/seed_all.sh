#!/bin/bash

# Comprehensive Database Seeding Script for Artisan Desk Storefront
# This script orchestrates database schema migration, product seeding, and demo user creation

set -e

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Check if database is already seeded (idempotency check)
check_if_seeded() {
    log_step "Checking if database is already seeded..."
    
    # Check if we have database connection info
    if [ -z "$DB_HOST" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
        log_warn "Database connection info not set, skipping seed check"
        return 1
    fi
    
    # Check if products table exists first
    local table_exists=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p ${DB_PORT:-5432} -U $DB_USER -d $DB_NAME -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'products');" 2>/dev/null || echo "f")
    table_exists=$(echo $table_exists | xargs)
    
    if [ "$table_exists" != "t" ]; then
        log_info "Products table does not exist - proceeding with seeding"
        return 1
    fi
    
    # Query product count
    local product_count=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p ${DB_PORT:-5432} -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM products;" 2>/dev/null || echo "0")
    product_count=$(echo $product_count | xargs)
    
    if [ "$product_count" -gt 0 ]; then
        log_info "Database already contains $product_count products - skipping seeding"
        echo "✅ Database already seeded with $product_count products"
        return 0
    fi
    
    log_info "Database is empty - proceeding with seeding"
    return 1
}

# Check dependencies
check_dependencies() {
    log_step "Checking dependencies..."
    
    local missing_deps=()
    
    # Check for psql (PostgreSQL client)
    if ! command -v psql &> /dev/null; then
        missing_deps+=("psql (PostgreSQL client)")
    fi
    
    # Check for python3
    if ! command -v python3 &> /dev/null; then
        missing_deps+=("python3")
    fi
    
    # Check for pip3
    if ! command -v pip3 &> /dev/null; then
        missing_deps+=("pip3")
    fi
    
    # Check for aws cli (for DynamoDB operations)
    if ! command -v aws &> /dev/null; then
        missing_deps+=("aws-cli")
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        log_error "Missing required dependencies:"
        for dep in "${missing_deps[@]}"; do
            echo "  - $dep"
        done
        echo ""
        echo "Please install the missing dependencies and try again."
        exit 1
    fi
    
    log_info "All dependencies are available"
}

# Install Python dependencies
install_python_deps() {
    log_step "Installing Python dependencies..."
    
    # Install PostgreSQL seeding dependencies
    if [ -f "$SCRIPT_DIR/postgresql/requirements.txt" ]; then
        log_info "Installing PostgreSQL seeding dependencies..."
        pip3 install -r "$SCRIPT_DIR/postgresql/requirements.txt" --user
    fi
    
    # Install DynamoDB seeding dependencies
    if [ -f "$SCRIPT_DIR/dynamodb/requirements.txt" ]; then
        log_info "Installing DynamoDB seeding dependencies..."
        pip3 install -r "$SCRIPT_DIR/dynamodb/requirements.txt" --user
    fi
    
    log_info "Python dependencies installed"
}

# Run PostgreSQL schema migration
run_schema_migration() {
    log_step "Running PostgreSQL schema migration..."
    
    if [ -f "$SCRIPT_DIR/postgresql/migrate.sh" ]; then
        cd "$SCRIPT_DIR/postgresql"
        
        # Check migration status first
        log_info "Checking current migration status..."
        ./migrate.sh status || log_warn "No migrations applied yet"
        
        # Run migration
        log_info "Applying artisan desk schema migration..."
        if ./migrate.sh up 001; then
            log_info "Schema migration completed successfully"
        else
            log_error "Schema migration failed"
            return 1
        fi
        
        cd "$PROJECT_ROOT"
    else
        log_error "Migration script not found: $SCRIPT_DIR/postgresql/migrate.sh"
        return 1
    fi
}

# Seed artisan desk products
seed_artisan_products() {
    log_step "Seeding artisan desk products..."
    
    if [ -f "$SCRIPT_DIR/postgresql/seed_artisan_desks.py" ]; then
        log_info "Generating 50 unique artisan desk products..."
        
        cd "$SCRIPT_DIR/postgresql"
        
        # Clear existing products if --clear flag is provided
        if [[ "$*" == *"--clear"* ]]; then
            python3 seed_artisan_desks.py --clear
        else
            python3 seed_artisan_desks.py
        fi
        
        if [ $? -eq 0 ]; then
            log_info "Artisan desk products seeded successfully"
        else
            log_error "Product seeding failed"
            return 1
        fi
        
        cd "$PROJECT_ROOT"
    else
        log_error "Product seeding script not found: $SCRIPT_DIR/postgresql/seed_artisan_desks.py"
        return 1
    fi
}

# Create demo user account
create_demo_user() {
    log_step "Creating demo user account..."
    
    if [ -f "$SCRIPT_DIR/dynamodb/seed_demo_user.py" ]; then
        log_info "Creating demo user in DynamoDB..."
        
        cd "$SCRIPT_DIR/dynamodb"
        
        # Force recreate if --force flag is provided
        if [[ "$*" == *"--force"* ]]; then
            python3 seed_demo_user.py --force
        else
            python3 seed_demo_user.py
        fi
        
        if [ $? -eq 0 ]; then
            log_info "Demo user created successfully"
        else
            log_error "Demo user creation failed"
            return 1
        fi
        
        cd "$PROJECT_ROOT"
    else
        log_error "Demo user seeding script not found: $SCRIPT_DIR/dynamodb/seed_demo_user.py"
        return 1
    fi
}

# Verify seeding results
verify_seeding() {
    log_step "Verifying seeding results..."
    
    # Verify PostgreSQL products
    log_info "Verifying artisan desk products..."
    if command -v psql &> /dev/null; then
        PGPASSWORD=${DB_PASSWORD:-password} psql \
            -h ${DB_HOST:-localhost} \
            -p ${DB_PORT:-5432} \
            -U ${DB_USER:-postgres} \
            -d ${DB_NAME:-shopsmart_catalog} \
            -c "SELECT COUNT(*) as artisan_desks FROM products WHERE category = 'Artisanal Desks';" \
            2>/dev/null || log_warn "Could not verify PostgreSQL products (database may not be running)"
    fi
    
    # Note: DynamoDB verification is handled within the demo user script
    log_info "Seeding verification completed"
}

# Display summary
show_summary() {
    log_step "Seeding Summary"
    
    echo ""
    echo "🎨 Artisan Desk Storefront Database Seeding Complete!"
    echo ""
    echo "What was created:"
    echo "  ✓ PostgreSQL schema extended with artisan desk columns"
    echo "  ✓ 50 unique artisan desk products with luxury pricing"
    echo "  ✓ Demo user account for testing (demo@artisandesks.com / demo)"
    echo "  ✓ Sample cart items for demo user"
    echo ""
    echo "Next steps:"
    echo "  1. Deploy the updated CDK stack to apply infrastructure changes"
    echo "  2. Test the demo user login through the User Auth API"
    echo "  3. Verify product catalog API returns artisan desk products"
    echo "  4. Begin frontend development for the storefront"
    echo ""
    echo "Demo user credentials:"
    echo "  Email: demo@artisandesks.com"
    echo "  Password: demo"
    echo ""
}

# Main execution
main() {
    echo "🚀 Artisan Desk Storefront Database Seeding"
    echo "=============================================="
    echo ""
    
    # Check if database is already seeded (idempotency)
    if check_if_seeded; then
        exit 0
    fi
    
    # Parse command line arguments
    local skip_deps=false
    local skip_migration=false
    local skip_products=false
    local skip_user=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-deps)
                skip_deps=true
                shift
                ;;
            --skip-migration)
                skip_migration=true
                shift
                ;;
            --skip-products)
                skip_products=true
                shift
                ;;
            --skip-user)
                skip_user=true
                shift
                ;;
            --help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --skip-deps       Skip dependency checking and installation"
                echo "  --skip-migration  Skip PostgreSQL schema migration"
                echo "  --skip-products   Skip artisan desk product seeding"
                echo "  --skip-user       Skip demo user creation"
                echo "  --clear           Clear existing products before seeding"
                echo "  --force           Force recreate demo user if exists"
                echo "  --help            Show this help message"
                echo ""
                echo "Environment variables:"
                echo "  DB_HOST           PostgreSQL host (default: localhost)"
                echo "  DB_PORT           PostgreSQL port (default: 5432)"
                echo "  DB_NAME           PostgreSQL database (default: shopsmart_catalog)"
                echo "  DB_USER           PostgreSQL user (default: postgres)"
                echo "  DB_PASSWORD       PostgreSQL password (default: password)"
                echo "  AWS_REGION        AWS region for DynamoDB (default: us-east-1)"
                echo "  PROJECT_NAME      Project name for DynamoDB tables (default: shopsmart)"
                echo "  ENVIRONMENT       Environment for DynamoDB tables (default: dev)"
                exit 0
                ;;
            *)
                # Pass through other arguments (like --clear, --force)
                shift
                ;;
        esac
    done
    
    # Execute seeding steps
    if [ "$skip_deps" = false ]; then
        check_dependencies
        install_python_deps
    fi
    
    if [ "$skip_migration" = false ]; then
        run_schema_migration || exit 1
    fi
    
    if [ "$skip_products" = false ]; then
        seed_artisan_products "$@" || exit 1
    fi
    
    if [ "$skip_user" = false ]; then
        create_demo_user "$@" || exit 1
    fi
    
    verify_seeding
    show_summary
    
    log_info "Database seeding completed successfully! 🎉"
}

# Run main function with all arguments
main "$@"