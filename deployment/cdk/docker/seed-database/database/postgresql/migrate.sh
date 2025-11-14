#!/bin/bash

# Database Migration Script for ShopSmart Product Catalog
# Usage: ./migrate.sh [up|down] [migration_version]

set -e

# Configuration
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-shopsmart_catalog}
DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-password}

MIGRATIONS_DIR="$(dirname "$0")/migrations"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Check if psql is available
check_dependencies() {
    if ! command -v psql &> /dev/null; then
        log_error "psql command not found. Please install PostgreSQL client."
        exit 1
    fi
}

# Test database connection
test_connection() {
    log_info "Testing database connection..."
    if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT 1;" &> /dev/null; then
        log_info "Database connection successful"
    else
        log_error "Failed to connect to database. Please check your connection parameters."
        exit 1
    fi
}

# Run migration up
migrate_up() {
    local version=$1
    local migration_file="$MIGRATIONS_DIR/${version}_add_artisan_desk_columns.sql"
    
    if [[ ! -f "$migration_file" ]]; then
        log_error "Migration file not found: $migration_file"
        exit 1
    fi
    
    log_info "Running migration $version (up)..."
    
    if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$migration_file"; then
        log_info "Migration $version completed successfully"
    else
        log_error "Migration $version failed"
        exit 1
    fi
}

# Run migration down (rollback)
migrate_down() {
    local version=$1
    local rollback_file="$MIGRATIONS_DIR/${version}_add_artisan_desk_columns_rollback.sql"
    
    if [[ ! -f "$rollback_file" ]]; then
        log_error "Rollback file not found: $rollback_file"
        exit 1
    fi
    
    log_warn "Rolling back migration $version..."
    
    if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$rollback_file"; then
        log_info "Rollback $version completed successfully"
    else
        log_error "Rollback $version failed"
        exit 1
    fi
}

# Show migration status
show_status() {
    log_info "Checking migration status..."
    PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "
        SELECT version, description, applied_at 
        FROM schema_migrations 
        ORDER BY version;
    " 2>/dev/null || log_warn "No migrations table found or no migrations applied"
}

# Main script logic
main() {
    local action=$1
    local version=${2:-"001"}
    
    check_dependencies
    test_connection
    
    case $action in
        "up")
            migrate_up $version
            ;;
        "down")
            migrate_down $version
            ;;
        "status")
            show_status
            ;;
        *)
            echo "Usage: $0 [up|down|status] [migration_version]"
            echo ""
            echo "Commands:"
            echo "  up      - Apply migration (default version: 001)"
            echo "  down    - Rollback migration (default version: 001)"
            echo "  status  - Show migration status"
            echo ""
            echo "Environment variables:"
            echo "  DB_HOST     - Database host (default: localhost)"
            echo "  DB_PORT     - Database port (default: 5432)"
            echo "  DB_NAME     - Database name (default: shopsmart_catalog)"
            echo "  DB_USER     - Database user (default: postgres)"
            echo "  DB_PASSWORD - Database password (default: password)"
            exit 1
            ;;
    esac
}

main "$@"