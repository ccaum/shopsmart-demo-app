#!/bin/bash

# Health Check Script for Order Processing Service
# This script performs comprehensive health checks for the service

set -e

# Configuration
SERVICE_URL="${SERVICE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-10}"
MAX_RETRIES="${MAX_RETRIES:-3}"

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

# Function to check if curl is available
check_curl() {
    if ! command -v curl &> /dev/null; then
        log_error "curl is not installed or not in PATH"
        exit 1
    fi
}

# Function to perform HTTP health check
http_health_check() {
    local endpoint=$1
    local expected_status=${2:-200}
    local description=$3
    
    log_info "Checking $description..."
    
    local response
    local http_code
    
    for i in $(seq 1 $MAX_RETRIES); do
        response=$(curl -s -w "%{http_code}" --max-time $TIMEOUT "$SERVICE_URL$endpoint" 2>/dev/null || echo "000")
        http_code="${response: -3}"
        
        if [ "$http_code" = "$expected_status" ]; then
            log_info "$description: PASSED (HTTP $http_code)"
            return 0
        else
            log_warn "$description: FAILED (HTTP $http_code) - Attempt $i/$MAX_RETRIES"
            if [ $i -lt $MAX_RETRIES ]; then
                sleep 2
            fi
        fi
    done
    
    log_error "$description: FAILED after $MAX_RETRIES attempts"
    return 1
}

# Function to check service response time
check_response_time() {
    local endpoint=$1
    local max_time=${2:-2000}  # milliseconds
    local description=$3
    
    log_info "Checking $description response time..."
    
    local response_time
    response_time=$(curl -s -w "%{time_total}" --max-time $TIMEOUT -o /dev/null "$SERVICE_URL$endpoint" 2>/dev/null || echo "999")
    
    # Convert to milliseconds
    response_time_ms=$(echo "$response_time * 1000" | bc -l 2>/dev/null || echo "999000")
    response_time_ms=${response_time_ms%.*}  # Remove decimal part
    
    if [ "$response_time_ms" -lt "$max_time" ]; then
        log_info "$description response time: PASSED (${response_time_ms}ms < ${max_time}ms)"
        return 0
    else
        log_error "$description response time: FAILED (${response_time_ms}ms >= ${max_time}ms)"
        return 1
    fi
}

# Function to check API endpoints
check_api_endpoints() {
    log_info "Checking API endpoints..."
    
    local failed=0
    
    # Basic health check
    if ! http_health_check "/health" "200" "Basic health check"; then
        failed=$((failed + 1))
    fi
    
    # Readiness check
    if ! http_health_check "/health/ready" "200" "Readiness check"; then
        failed=$((failed + 1))
    fi
    
    # API documentation
    if ! http_health_check "/docs" "200" "API documentation"; then
        failed=$((failed + 1))
    fi
    
    # OpenAPI schema
    if ! http_health_check "/openapi.json" "200" "OpenAPI schema"; then
        failed=$((failed + 1))
    fi
    
    return $failed
}

# Function to check response times
check_performance() {
    log_info "Checking performance..."
    
    local failed=0
    
    # Health endpoint should respond quickly
    if ! check_response_time "/health" "500" "Health endpoint"; then
        failed=$((failed + 1))
    fi
    
    # Readiness endpoint should respond reasonably fast
    if ! check_response_time "/health/ready" "2000" "Readiness endpoint"; then
        failed=$((failed + 1))
    fi
    
    return $failed
}

# Function to check service dependencies (if accessible)
check_dependencies() {
    log_info "Checking service dependencies..."
    
    # This would check MongoDB, Product Service, Auth Service
    # For now, we'll just check if the readiness endpoint passes
    # which includes dependency checks
    
    if http_health_check "/health/ready" "200" "Dependencies check"; then
        log_info "Dependencies: PASSED"
        return 0
    else
        log_error "Dependencies: FAILED"
        return 1
    fi
}

# Function to run comprehensive health check
run_comprehensive_check() {
    log_info "Starting comprehensive health check for Order Processing Service"
    log_info "Service URL: $SERVICE_URL"
    log_info "Timeout: ${TIMEOUT}s"
    log_info "Max retries: $MAX_RETRIES"
    echo ""
    
    local total_failed=0
    
    # Check API endpoints
    if ! check_api_endpoints; then
        total_failed=$((total_failed + $?))
    fi
    
    echo ""
    
    # Check performance
    if ! check_performance; then
        total_failed=$((total_failed + $?))
    fi
    
    echo ""
    
    # Check dependencies
    if ! check_dependencies; then
        total_failed=$((total_failed + 1))
    fi
    
    echo ""
    
    if [ $total_failed -eq 0 ]; then
        log_info "All health checks PASSED ✓"
        return 0
    else
        log_error "$total_failed health check(s) FAILED ✗"
        return 1
    fi
}

# Function to run quick health check
run_quick_check() {
    log_info "Running quick health check..."
    
    if http_health_check "/health" "200" "Quick health check"; then
        log_info "Service is healthy ✓"
        return 0
    else
        log_error "Service is unhealthy ✗"
        return 1
    fi
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS] [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  quick      - Quick health check (default)"
    echo "  full       - Comprehensive health check"
    echo "  help       - Show this help message"
    echo ""
    echo "Options:"
    echo "  SERVICE_URL    - Service URL (default: http://localhost:8000)"
    echo "  TIMEOUT        - Request timeout in seconds (default: 10)"
    echo "  MAX_RETRIES    - Maximum retry attempts (default: 3)"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Quick check on localhost"
    echo "  $0 full                              # Full check on localhost"
    echo "  SERVICE_URL=http://prod-service $0   # Quick check on production"
    echo "  TIMEOUT=30 MAX_RETRIES=5 $0 full     # Full check with custom settings"
}

# Main script logic
check_curl

case "${1:-quick}" in
    "quick")
        run_quick_check
        ;;
    "full")
        run_comprehensive_check
        ;;
    "help"|"-h"|"--help")
        show_usage
        exit 0
        ;;
    *)
        log_error "Unknown command: $1"
        show_usage
        exit 1
        ;;
esac

exit $?