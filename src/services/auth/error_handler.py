"""
Comprehensive Error Handling Module for User Auth Service
Provides standardized error responses, retry logic, and DynamoDB connection handling
"""

import logging
import asyncio
import traceback
from typing import Dict, Any, Optional, Callable, Union
from functools import wraps
from datetime import datetime, timedelta
import boto3
from botocore.exceptions import ClientError, BotoCoreError
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

class DynamoDBError(ServiceError):
    """DynamoDB-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "DYNAMODB_ERROR", 503, details)

class AuthenticationError(ServiceError):
    """Authentication-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "AUTHENTICATION_ERROR", 401, details)

class AuthorizationError(ServiceError):
    """Authorization-related errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "AUTHORIZATION_ERROR", 403, details)

class ValidationError(ServiceError):
    """Input validation errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "VALIDATION_ERROR", 400, details)

class NotFoundError(ServiceError):
    """Resource not found errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "NOT_FOUND", 404, details)

class ConflictError(ServiceError):
    """Resource conflict errors (e.g., duplicate user)"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "CONFLICT", 409, details)

class RateLimitError(ServiceError):
    """Rate limiting errors"""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__(message, "RATE_LIMIT_EXCEEDED", 429, details)

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

class DynamoDBManager:
    """Manages DynamoDB operations with retry logic and error handling"""
    
    def __init__(self, dynamodb_resource, retry_config: RetryConfig = None):
        self.dynamodb = dynamodb_resource
        self.retry_config = retry_config or RetryConfig()
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=5,
            recovery_timeout=30,
            expected_exception=DynamoDBError
        )
    
    async def execute_with_retry(self, operation: Callable, *args, **kwargs):
        """Execute DynamoDB operation with retry logic"""
        
        async def _execute():
            try:
                return await operation(*args, **kwargs)
            except ClientError as e:
                error_code = e.response['Error']['Code']
                error_message = e.response['Error']['Message']
                
                # Handle specific DynamoDB errors
                if error_code == 'ResourceNotFoundException':
                    raise NotFoundError(f"DynamoDB resource not found: {error_message}")
                elif error_code == 'ConditionalCheckFailedException':
                    raise ConflictError(f"Conditional check failed: {error_message}")
                elif error_code == 'ProvisionedThroughputExceededException':
                    raise RateLimitError(f"DynamoDB throughput exceeded: {error_message}")
                elif error_code == 'ValidationException':
                    raise ValidationError(f"DynamoDB validation error: {error_message}")
                else:
                    raise DynamoDBError(f"DynamoDB error ({error_code}): {error_message}", {
                        "error_code": error_code,
                        "request_id": e.response.get('ResponseMetadata', {}).get('RequestId')
                    })
            except BotoCoreError as e:
                logger.error(f"BotoCore error: {e}")
                raise DynamoDBError(f"AWS SDK error: {str(e)}")
            except Exception as e:
                logger.error(f"Unexpected DynamoDB error: {e}")
                raise DynamoDBError(f"Unexpected DynamoDB error: {str(e)}")
        
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
    
    def __init__(self, dynamodb_resource):
        self.dynamodb = dynamodb_resource
    
    async def check_dynamodb(self) -> Dict[str, Any]:
        """Check DynamoDB connectivity and performance"""
        try:
            start_time = datetime.utcnow()
            
            # Try to describe a table to test connectivity
            table_name = 'Users'  # Assuming Users table exists
            table = self.dynamodb.Table(table_name)
            table.load()
            
            duration = (datetime.utcnow() - start_time).total_seconds()
            
            return {
                "status": "healthy",
                "response_time_ms": round(duration * 1000, 2),
                "table_status": table.table_status
            }
            
        except Exception as e:
            logger.error(f"DynamoDB health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
                "type": type(e).__name__
            }
    
    async def comprehensive_health_check(self) -> Dict[str, Any]:
        """Perform comprehensive health check"""
        
        dynamodb_health = await self.check_dynamodb()
        
        overall_status = "healthy"
        if dynamodb_health["status"] != "healthy":
            overall_status = "unhealthy"
        
        return {
            "status": overall_status,
            "timestamp": datetime.utcnow().isoformat(),
            "service": "user-auth",
            "version": "1.0.0",
            "dependencies": {
                "dynamodb": dynamodb_health
            }
        }

class TokenValidator:
    """JWT token validation with comprehensive error handling"""
    
    def __init__(self, secret_key: str, algorithm: str = "HS256"):
        self.secret_key = secret_key
        self.algorithm = algorithm
    
    def validate_token(self, token: str) -> Dict[str, Any]:
        """Validate JWT token with detailed error handling"""
        try:
            import jwt
            
            payload = jwt.decode(token, self.secret_key, algorithms=[self.algorithm])
            
            # Check expiration
            if 'exp' in payload:
                exp_timestamp = payload['exp']
                if datetime.utcnow().timestamp() > exp_timestamp:
                    raise AuthenticationError("Token has expired", {
                        "expired_at": datetime.fromtimestamp(exp_timestamp).isoformat()
                    })
            
            return payload
            
        except jwt.ExpiredSignatureError:
            raise AuthenticationError("Token has expired")
        except jwt.InvalidTokenError as e:
            raise AuthenticationError(f"Invalid token: {str(e)}")
        except Exception as e:
            logger.error(f"Token validation error: {e}")
            raise AuthenticationError("Token validation failed")

class PasswordValidator:
    """Password validation with security requirements"""
    
    @staticmethod
    def validate_password_strength(password: str) -> Dict[str, Any]:
        """Validate password strength and return detailed feedback"""
        
        errors = []
        warnings = []
        
        if len(password) < 8:
            errors.append("Password must be at least 8 characters long")
        
        if not any(c.isupper() for c in password):
            warnings.append("Password should contain at least one uppercase letter")
        
        if not any(c.islower() for c in password):
            warnings.append("Password should contain at least one lowercase letter")
        
        if not any(c.isdigit() for c in password):
            warnings.append("Password should contain at least one number")
        
        if not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?" for c in password):
            warnings.append("Password should contain at least one special character")
        
        if errors:
            raise ValidationError("Password does not meet requirements", {
                "errors": errors,
                "warnings": warnings
            })
        
        return {
            "valid": True,
            "warnings": warnings,
            "strength": "strong" if not warnings else "medium"
        }