"""
Comprehensive Error Handling Module for Product Catalog Service
Provides standardized error responses, retry logic, and database connection handling
"""

import logging
import asyncio
import traceback
from typing import Dict, Any, Optional, Callable, Union
from functools import wraps
from datetime import datetime, timedelta
import asyncpg
import redis.exceptions
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

class DatabaseError(ServiceError):
    """Database-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "DATABASE_ERROR", 503, details)

class CacheError(ServiceError):
    """Cache-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "CACHE_ERROR", 503, details)

class ValidationError(ServiceError):
    """Input validation errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "VALIDATION_ERROR", 400, details)

class NotFoundError(ServiceError):
    """Resource not found errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "NOT_FOUND", 404, details)

class RateLimitError(ServiceError):
    """Rate limiting errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "RATE_LIMIT_EXCEEDED", 429, details)

class ExternalServiceError(ServiceError):
    """External service communication errors"""
    def __init__(self, message: str, service_name: str, details: Optional[Dict] = None):
        details = details or {}
        details['service_name'] = service_name
        super().__init__(message, "EXTERNAL_SERVICE_ERROR", 502, details)

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

class DatabaseConnectionManager:
    """Manages database connections with retry logic and circuit breaker"""
    
    def __init__(self, db_pool, retry_config: RetryConfig = None):
        self.db_pool = db_pool
        self.retry_config = retry_config or RetryConfig()
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=5,
            recovery_timeout=30,
            expected_exception=DatabaseError
        )
    
    async def execute_with_retry(self, operation: Callable, *args, **kwargs):
        """Execute database operation with retry logic"""
        
        async def _execute():
            try:
                async with self.db_pool.acquire() as conn:
                    return await operation(conn, *args, **kwargs)
            except asyncpg.PostgresError as e:
                logger.error(f"Database error: {e}")
                raise DatabaseError(f"Database operation failed: {str(e)}", {
                    "postgres_code": e.sqlstate,
                    "severity": getattr(e, 'severity', None)
                })
            except Exception as e:
                logger.error(f"Unexpected database error: {e}")
                raise DatabaseError(f"Unexpected database error: {str(e)}")
        
        return await self.circuit_breaker.call(_execute)

class CacheManager:
    """Manages cache operations with error handling"""
    
    def __init__(self, redis_client, retry_config: RetryConfig = None):
        self.redis_client = redis_client
        self.retry_config = retry_config or RetryConfig(max_attempts=2, base_delay=0.1)
    
    async def get_with_fallback(self, key: str, fallback_func: Callable = None):
        """Get from cache with fallback to database"""
        try:
            result = await self.redis_client.get(key)
            if result:
                return json.loads(result)
        except redis.exceptions.RedisError as e:
            logger.warning(f"Cache get failed for key {key}: {e}")
        except Exception as e:
            logger.error(f"Unexpected cache error for key {key}: {e}")
        
        # Fallback to database if provided
        if fallback_func:
            try:
                return await fallback_func()
            except Exception as e:
                logger.error(f"Fallback function failed: {e}")
                raise
        
        return None
    
    async def set_with_retry(self, key: str, value: Any, ttl: int = 3600):
        """Set cache value with retry logic"""
        for attempt in range(self.retry_config.max_attempts):
            try:
                await self.redis_client.setex(key, ttl, json.dumps(value))
                return True
            except redis.exceptions.RedisError as e:
                logger.warning(f"Cache set failed for key {key} (attempt {attempt + 1}): {e}")
                if attempt < self.retry_config.max_attempts - 1:
                    await asyncio.sleep(self.retry_config.base_delay * (2 ** attempt))
                else:
                    logger.error(f"Cache set failed permanently for key {key}")
        
        return False

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
    
    def __init__(self, db_pool, redis_client):
        self.db_pool = db_pool
        self.redis_client = redis_client
    
    async def check_database(self) -> Dict[str, Any]:
        """Check database connectivity and performance"""
        try:
            start_time = datetime.utcnow()
            
            async with self.db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
                
            duration = (datetime.utcnow() - start_time).total_seconds()
            
            return {
                "status": "healthy",
                "response_time_ms": round(duration * 1000, 2),
                "pool_size": self.db_pool.get_size(),
                "pool_free": self.db_pool.get_idle_size()
            }
            
        except Exception as e:
            logger.error(f"Database health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
                "type": type(e).__name__
            }
    
    async def check_cache(self) -> Dict[str, Any]:
        """Check Redis connectivity and performance"""
        try:
            start_time = datetime.utcnow()
            
            await self.redis_client.ping()
            
            duration = (datetime.utcnow() - start_time).total_seconds()
            
            return {
                "status": "healthy",
                "response_time_ms": round(duration * 1000, 2)
            }
            
        except Exception as e:
            logger.error(f"Cache health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
                "type": type(e).__name__
            }
    
    async def comprehensive_health_check(self) -> Dict[str, Any]:
        """Perform comprehensive health check"""
        
        db_health = await self.check_database()
        cache_health = await self.check_cache()
        
        overall_status = "healthy"
        if db_health["status"] != "healthy":
            overall_status = "unhealthy"
        elif cache_health["status"] != "healthy":
            overall_status = "degraded"  # Cache issues are not critical
        
        return {
            "status": overall_status,
            "timestamp": datetime.utcnow().isoformat(),
            "service": "product-catalog",
            "version": "1.0.0",
            "dependencies": {
                "database": db_health,
                "cache": cache_health
            }
        }