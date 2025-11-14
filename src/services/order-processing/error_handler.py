"""
Comprehensive Error Handling Module for Order Processing Service
Provides standardized error responses, retry logic, and MongoDB connection handling
"""

import logging
import asyncio
import traceback
from typing import Dict, Any, Optional, Callable, Union
from functools import wraps
from datetime import datetime, timedelta
from pymongo.errors import (
    PyMongoError, ConnectionFailure, ServerSelectionTimeoutError,
    DuplicateKeyError, WriteError, OperationFailure
)
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
import json

logger = logging.getLogger(__name__)

class ServiceError(Exception):
    """Base service error class"""
    def __init__(self, message: str, code: str, status_code: int = 500, details: Optional[Dict] = None):
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(self.message)

class MongoDBError(ServiceError):
    """MongoDB-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "MONGODB_ERROR", 503, details)

class ValidationError(ServiceError):
    """Input validation errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "VALIDATION_ERROR", 400, details)

class NotFoundError(ServiceError):
    """Resource not found errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "NOT_FOUND", 404, details)

class ConflictError(ServiceError):
    """Resource conflict errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "CONFLICT", 409, details)

class BusinessLogicError(ServiceError):
    """Business logic validation errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "BUSINESS_LOGIC_ERROR", 422, details)

class ExternalServiceError(ServiceError):
    """External service communication errors"""
    def __init__(self, message: str, service_name: str, details: Optional[Dict] = None):
        details = details or {}
        details['service_name'] = service_name
        super().__init__(message, "EXTERNAL_SERVICE_ERROR", 502, details)

class PaymentError(ServiceError):
    """Payment processing errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "PAYMENT_ERROR", 402, details)

class InventoryError(ServiceError):
    """Inventory-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "INVENTORY_ERROR", 409, details)

class ErrorResponse:
    """Standardized error response format"""
    
    @staticmethod
    def create_error_response(
        error: Union[Exception, ServiceError],
        request_id: Optional[str] = None,
        timestamp: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """Create standardized error response"""
        
        if timestamp is None:
            timestamp = datetime.utcnow()
        
        if isinstance(error, ServiceError):
            return {
                "error": {
                    "message": error.message,
                    "code": error.code,
                    "details": error.details,
                    "timestamp": timestamp.isoformat(),
                    "request_id": request_id
                }
            }
        elif isinstance(error, HTTPException):
            return {
                "error": {
                    "message": error.detail,
                    "code": "HTTP_ERROR",
                    "details": {"status_code": error.status_code},
                    "timestamp": timestamp.isoformat(),
                    "request_id": request_id
                }
            }
        else:
            # Generic error
            return {
                "error": {
                    "message": "An unexpected error occurred",
                    "code": "INTERNAL_ERROR",
                    "details": {"type": type(error).__name__},
                    "timestamp": timestamp.isoformat(),
                    "request_id": request_id
                }
            }

class RetryConfig:
    """Configuration for retry logic"""
    
    def __init__(
        self,
        max_attempts: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        exponential_base: float = 2.0,
        jitter: bool = True
    ):
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.exponential_base = exponential_base
        self.jitter = jitter

class MongoDBManager:
    """Manages MongoDB operations with retry logic and error handling"""
    
    def __init__(self, mongo_client, retry_config: RetryConfig = None):
        self.mongo_client = mongo_client
        self.retry_config = retry_config or RetryConfig()
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=5,
            recovery_timeout=30,
            expected_exception=MongoDBError
        )
    
    async def execute_with_retry(self, operation: Callable, *args, **kwargs):
        """Execute MongoDB operation with retry logic"""
        
        async def _execute():
            try:
                return await operation(*args, **kwargs)
            except DuplicateKeyError as e:
                raise ConflictError(f"Duplicate key error: {str(e)}", {
                    "duplicate_key": str(e.details.get('keyValue', {}))
                })
            except WriteError as e:
                raise MongoDBError(f"MongoDB write error: {str(e)}", {
                    "error_code": e.code,
                    "error_labels": e.details.get('errorLabels', [])
                })
            except OperationFailure as e:
                if e.code == 11000:  # Duplicate key
                    raise ConflictError(f"Duplicate key error: {str(e)}")
                else:
                    raise MongoDBError(f"MongoDB operation failed: {str(e)}", {
                        "error_code": e.code
                    })
            except ConnectionFailure as e:
                logger.error(f"MongoDB connection failure: {e}")
                raise MongoDBError(f"Database connection failed: {str(e)}")
            except ServerSelectionTimeoutError as e:
                logger.error(f"MongoDB server selection timeout: {e}")
                raise MongoDBError(f"Database server unavailable: {str(e)}")
            except PyMongoError as e:
                logger.error(f"MongoDB error: {e}")
                raise MongoDBError(f"Database error: {str(e)}")
            except Exception as e:
                logger.error(f"Unexpected MongoDB error: {e}")
                raise MongoDBError(f"Unexpected database error: {str(e)}")
        
        return await self.circuit_breaker.call(_execute)

class CircuitBreaker:
    """Circuit breaker pattern implementation"""
    
    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: int = 60,
        expected_exception: type = Exception
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception
        
        self.failure_count = 0
        self.last_failure_time = None
        self.state = 'CLOSED'  # CLOSED, OPEN, HALF_OPEN
    
    async def call(self, func: Callable, *args, **kwargs):
        """Execute function with circuit breaker protection"""
        
        if self.state == 'OPEN':
            if self._should_attempt_reset():
                self.state = 'HALF_OPEN'
            else:
                raise ServiceError(
                    "Service temporarily unavailable",
                    "CIRCUIT_BREAKER_OPEN",
                    503,
                    {"retry_after": self.recovery_timeout}
                )
        
        try:
            result = await func(*args, **kwargs)
            self._on_success()
            return result
        except self.expected_exception as e:
            self._on_failure()
            raise
        except Exception as e:
            # Unexpected errors don't count towards circuit breaker
            logger.error(f"Unexpected error in circuit breaker: {e}")
            raise
    
    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt reset"""
        if self.last_failure_time is None:
            return True
        
        return (datetime.utcnow() - self.last_failure_time).total_seconds() >= self.recovery_timeout
    
    def _on_success(self):
        """Handle successful operation"""
        self.failure_count = 0
        self.state = 'CLOSED'
    
    def _on_failure(self):
        """Handle failed operation"""
        self.failure_count += 1
        self.last_failure_time = datetime.utcnow()
        
        if self.failure_count >= self.failure_threshold:
            self.state = 'OPEN'
            logger.warning(f"Circuit breaker opened after {self.failure_count} failures")

class ExternalServiceManager:
    """Manages external service calls with retry and circuit breaker"""
    
    def __init__(self, service_name: str, retry_config: RetryConfig = None):
        self.service_name = service_name
        self.retry_config = retry_config or RetryConfig(max_attempts=3, base_delay=0.5)
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=3,
            recovery_timeout=60,
            expected_exception=ExternalServiceError
        )
    
    async def call_service(self, operation: Callable, *args, **kwargs):
        """Call external service with retry and circuit breaker"""
        
        async def _call():
            try:
                return await operation(*args, **kwargs)
            except Exception as e:
                logger.error(f"External service {self.service_name} error: {e}")
                raise ExternalServiceError(
                    f"Failed to communicate with {self.service_name}",
                    self.service_name,
                    {"original_error": str(e)}
                )
        
        return await self.circuit_breaker.call(_call)

def with_error_handling(
    retry_config: RetryConfig = None,
    log_errors: bool = True,
    track_metrics: bool = True
):
    """Decorator for comprehensive error handling"""
    
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            start_time = datetime.utcnow()
            request_id = kwargs.get('request_id') or f"req_{int(start_time.timestamp())}"
            
            try:
                result = await func(*args, **kwargs)
                
                if track_metrics:
                    duration = (datetime.utcnow() - start_time).total_seconds()
                    logger.info(f"Operation {func.__name__} completed successfully in {duration:.3f}s")
                
                return result
                
            except ServiceError as e:
                if log_errors:
                    logger.error(f"Service error in {func.__name__}: {e.message}", extra={
                        "error_code": e.code,
                        "status_code": e.status_code,
                        "details": e.details,
                        "request_id": request_id
                    })
                raise
                
            except Exception as e:
                if log_errors:
                    logger.error(f"Unexpected error in {func.__name__}: {str(e)}", extra={
                        "error_type": type(e).__name__,
                        "traceback": traceback.format_exc(),
                        "request_id": request_id
                    })
                
                # Convert to ServiceError
                raise ServiceError(
                    "An unexpected error occurred",
                    "INTERNAL_ERROR",
                    500,
                    {"original_error": str(e), "type": type(e).__name__}
                )
        
        return wrapper
    return decorator

async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Global exception handler for FastAPI"""
    
    request_id = getattr(request.state, 'request_id', None)
    
    if isinstance(exc, ServiceError):
        logger.error(f"Service error: {exc.message}", extra={
            "error_code": exc.code,
            "status_code": exc.status_code,
            "details": exc.details,
            "request_id": request_id,
            "path": request.url.path
        })
        
        return JSONResponse(
            status_code=exc.status_code,
            content=ErrorResponse.create_error_response(exc, request_id)
        )
    
    elif isinstance(exc, HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content=ErrorResponse.create_error_response(exc, request_id)
        )
    
    else:
        # Log unexpected errors
        logger.error(f"Unexpected error: {str(exc)}", extra={
            "error_type": type(exc).__name__,
            "traceback": traceback.format_exc(),
            "request_id": request_id,
            "path": request.url.path
        })
        
        # Don't expose internal error details in production
        error = ServiceError(
            "An internal server error occurred",
            "INTERNAL_ERROR",
            500
        )
        
        return JSONResponse(
            status_code=500,
            content=ErrorResponse.create_error_response(error, request_id)
        )

class HealthChecker:
    """Health check utilities with dependency validation"""
    
    def __init__(self, mongo_client):
        self.mongo_client = mongo_client
    
    async def check_mongodb(self) -> Dict[str, Any]:
        """Check MongoDB connectivity and performance"""
        try:
            start_time = datetime.utcnow()
            
            # Ping MongoDB to test connectivity
            await self.mongo_client.admin.command('ping')
            
            duration = (datetime.utcnow() - start_time).total_seconds()
            
            # Get server info
            server_info = await self.mongo_client.admin.command('serverStatus')
            
            return {
                "status": "healthy",
                "response_time_ms": round(duration * 1000, 2),
                "version": server_info.get('version'),
                "uptime": server_info.get('uptime')
            }
            
        except Exception as e:
            logger.error(f"MongoDB health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
                "type": type(e).__name__
            }
    
    async def comprehensive_health_check(self) -> Dict[str, Any]:
        """Perform comprehensive health check"""
        
        mongodb_health = await self.check_mongodb()
        
        overall_status = "healthy"
        if mongodb_health["status"] != "healthy":
            overall_status = "unhealthy"
        
        return {
            "status": overall_status,
            "timestamp": datetime.utcnow().isoformat(),
            "service": "order-processing",
            "version": "1.0.0",
            "dependencies": {
                "mongodb": mongodb_health
            }
        }

class OrderValidator:
    """Order validation with business logic checks"""
    
    @staticmethod
    def validate_order_data(order_data: Dict[str, Any]) -> Dict[str, Any]:
        """Validate order data with comprehensive checks"""
        
        errors = []
        warnings = []
        
        # Required fields
        required_fields = ['customer_id', 'items', 'shipping_address', 'billing_address']
        for field in required_fields:
            if field not in order_data or not order_data[field]:
                errors.append(f"Field '{field}' is required")
        
        # Validate items
        if 'items' in order_data:
            items = order_data['items']
            if not isinstance(items, list) or len(items) == 0:
                errors.append("Order must contain at least one item")
            else:
                for i, item in enumerate(items):
                    if 'product_id' not in item:
                        errors.append(f"Item {i+1}: product_id is required")
                    if 'quantity' not in item or item['quantity'] <= 0:
                        errors.append(f"Item {i+1}: quantity must be greater than 0")
                    if 'unit_price' not in item or item['unit_price'] <= 0:
                        errors.append(f"Item {i+1}: unit_price must be greater than 0")
        
        # Validate addresses
        address_fields = ['street', 'city', 'state', 'zip_code', 'country']
        for address_type in ['shipping_address', 'billing_address']:
            if address_type in order_data:
                address = order_data[address_type]
                for field in address_fields:
                    if field not in address or not address[field]:
                        errors.append(f"{address_type}.{field} is required")
        
        if errors:
            raise ValidationError("Order validation failed", {
                "errors": errors,
                "warnings": warnings
            })
        
        return {
            "valid": True,
            "warnings": warnings
        }
    
    @staticmethod
    def validate_inventory_availability(items: list, inventory_data: Dict[str, int]) -> Dict[str, Any]:
        """Validate inventory availability for order items"""
        
        errors = []
        warnings = []
        
        for item in items:
            product_id = item.get('product_id')
            requested_quantity = item.get('quantity', 0)
            
            if product_id not in inventory_data:
                errors.append(f"Product {product_id} not found in inventory")
                continue
            
            available_quantity = inventory_data[product_id]
            
            if available_quantity < requested_quantity:
                if available_quantity == 0:
                    errors.append(f"Product {product_id} is out of stock")
                else:
                    errors.append(f"Product {product_id}: only {available_quantity} available, {requested_quantity} requested")
            elif available_quantity < requested_quantity * 2:
                warnings.append(f"Product {product_id}: low stock ({available_quantity} remaining)")
        
        if errors:
            raise InventoryError("Insufficient inventory for order", {
                "errors": errors,
                "warnings": warnings
            })
        
        return {
            "valid": True,
            "warnings": warnings
        }