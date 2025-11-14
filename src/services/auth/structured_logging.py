"""
Structured logging utilities for Lambda authentication functions
"""

import json
import uuid
import time
import logging
from datetime import datetime
from typing import Dict, Any, Optional
from functools import wraps

# Configure JSON logging for Lambda
class LambdaJSONFormatter(logging.Formatter):
    """JSON formatter optimized for AWS Lambda and CloudWatch Logs."""
    
    def format(self, record):
        """Format log record as JSON with Lambda-specific fields."""
        log_entry = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'service': 'auth-lambda',
            'aws_request_id': getattr(record, 'aws_request_id', ''),
            'function_name': getattr(record, 'function_name', ''),
            'function_version': getattr(record, 'function_version', ''),
        }
        
        # Add correlation ID if available
        correlation_id = getattr(record, 'correlation_id', '')
        if correlation_id:
            log_entry['correlation_id'] = correlation_id
        
        # Add extra fields from the record
        for key, value in record.__dict__.items():
            if key not in ['name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 
                          'filename', 'module', 'lineno', 'funcName', 'created', 
                          'msecs', 'relativeCreated', 'thread', 'threadName', 
                          'processName', 'process', 'getMessage', 'exc_info', 
                          'exc_text', 'stack_info', 'aws_request_id', 'function_name',
                          'function_version', 'correlation_id']:
                log_entry[key] = value
        
        # Add exception info if present
        if record.exc_info:
            log_entry['exception'] = self.formatException(record.exc_info)
            log_entry['error'] = True
        
        # Mark performance-related logs
        if any(keyword in record.getMessage().lower() 
               for keyword in ['slow', 'performance', 'duration', 'timeout', 'optimization', 'throttle']):
            log_entry['performance_marker'] = True
        
        return json.dumps(log_entry, default=str)


def setup_lambda_logging(context=None):
    """Set up structured logging for Lambda functions."""
    
    # Configure root logger
    root_logger = logging.getLogger()
    
    # Remove existing handlers
    for handler in root_logger.handlers:
        root_logger.removeHandler(handler)
    
    # Add new handler with JSON formatter
    handler = logging.StreamHandler()
    handler.setFormatter(LambdaJSONFormatter())
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)
    
    # Add context information if available
    if context:
        # Create a custom logger with context
        logger = logging.getLogger('auth-lambda')
        
        # Add context information to all log records
        old_factory = logging.getLogRecordFactory()
        
        def record_factory(*args, **kwargs):
            record = old_factory(*args, **kwargs)
            record.aws_request_id = context.aws_request_id
            record.function_name = context.function_name
            record.function_version = context.function_version
            return record
        
        logging.setLogRecordFactory(record_factory)
        
        return logger
    
    return logging.getLogger('auth-lambda')


class AuthStructuredLogger:
    """Helper class for structured logging in authentication service."""
    
    def __init__(self, context=None, correlation_id: str = None):
        self.logger = setup_lambda_logging(context)
        self.correlation_id = correlation_id or str(uuid.uuid4())
        self.context = context
    
    def _add_correlation_id(self, extra: Dict[str, Any]) -> Dict[str, Any]:
        """Add correlation ID to log extra data."""
        extra = extra or {}
        extra['correlation_id'] = self.correlation_id
        return extra
    
    def log_function_start(self, function_name: str, event: Dict[str, Any]):
        """Log function execution start."""
        self.logger.info(
            f"Function {function_name} started",
            extra=self._add_correlation_id({
                'function_name': function_name,
                'event_type': event.get('httpMethod', 'unknown'),
                'path': event.get('path', ''),
                'user_agent': event.get('headers', {}).get('User-Agent', ''),
            })
        )
    
    def log_function_end(self, function_name: str, duration: float, status_code: int, success: bool):
        """Log function execution end."""
        self.logger.info(
            f"Function {function_name} completed",
            extra=self._add_correlation_id({
                'function_name': function_name,
                'duration_ms': round(duration * 1000, 2),
                'status_code': status_code,
                'success': success,
                'performance_marker': duration > 5.0,  # Mark slow Lambda executions
            })
        )
    
    def log_authentication_attempt(self, email: str, success: bool, duration: float, 
                                  failure_reason: str = None):
        """Log authentication attempts."""
        log_data = {
            'event_type': 'authentication',
            'email': email,
            'success': success,
            'duration_ms': round(duration * 1000, 2),
            'performance_marker': duration > 2.0,  # Mark slow auth attempts
        }
        
        if not success and failure_reason:
            log_data['failure_reason'] = failure_reason
        
        self.logger.info(
            f"Authentication attempt: {'success' if success else 'failed'}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_registration_attempt(self, email: str, success: bool, duration: float, 
                                failure_reason: str = None):
        """Log registration attempts."""
        log_data = {
            'event_type': 'registration',
            'email': email,
            'success': success,
            'duration_ms': round(duration * 1000, 2),
            'performance_marker': duration > 3.0,  # Mark slow registrations
        }
        
        if not success and failure_reason:
            log_data['failure_reason'] = failure_reason
        
        self.logger.info(
            f"Registration attempt: {'success' if success else 'failed'}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_session_validation(self, session_id: str, success: bool, duration: float, 
                              user_id: str = None):
        """Log session validation attempts."""
        log_data = {
            'event_type': 'session_validation',
            'session_id': session_id,
            'success': success,
            'duration_ms': round(duration * 1000, 2),
            'performance_marker': duration > 1.0,  # Mark slow validations
        }
        
        if success and user_id:
            log_data['user_id'] = user_id
        
        self.logger.info(
            f"Session validation: {'valid' if success else 'invalid'}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_cart_operation(self, operation: str, user_id: str, success: bool, duration: float,
                          item_count: int = 0, product_id: str = None, error: str = None):
        """Log cart operations."""
        log_data = {
            'event_type': 'cart_operation',
            'operation': operation,
            'user_id': user_id,
            'success': success,
            'duration_ms': round(duration * 1000, 2),
            'performance_marker': duration > 1.5,  # Mark slow cart operations
        }
        
        if item_count > 0:
            log_data['item_count'] = item_count
        
        if product_id:
            log_data['product_id'] = product_id
        
        if not success and error:
            log_data['error'] = error
        
        self.logger.info(
            f"Cart {operation}: {'success' if success else 'failed'}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_dynamodb_operation(self, table_name: str, operation: str, duration: float, 
                              success: bool, throttled: bool = False, error: str = None):
        """Log DynamoDB operations."""
        log_data = {
            'event_type': 'dynamodb_operation',
            'table_name': table_name,
            'operation': operation,
            'duration_ms': round(duration * 1000, 2),
            'success': success,
            'throttled': throttled,
            'performance_marker': duration > 0.5 or throttled,  # Mark slow or throttled operations
        }
        
        if throttled:
            log_data['optimization_opportunity'] = 'Consider increasing DynamoDB capacity'
        
        if not success and error:
            log_data['error'] = error
        
        level = logging.WARNING if throttled or not success else logging.INFO
        self.logger.log(
            level,
            f"DynamoDB {operation} on {table_name}: {'success' if success else 'failed'}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_performance_issue(self, issue_type: str, description: str, 
                             optimization_suggestion: str = None, **kwargs):
        """Log performance issues."""
        log_data = {
            'event_type': 'performance_issue',
            'issue_type': issue_type,
            'description': description,
            'performance_marker': True,
        }
        
        if optimization_suggestion:
            log_data['optimization_suggestion'] = optimization_suggestion
        
        log_data.update(kwargs)
        
        self.logger.warning(
            f"Performance issue: {issue_type}",
            extra=self._add_correlation_id(log_data)
        )
    
    def log_optimization_opportunity(self, opportunity_type: str, description: str, 
                                   potential_savings: str = None, **kwargs):
        """Log optimization opportunities."""
        log_data = {
            'event_type': 'optimization_opportunity',
            'opportunity_type': opportunity_type,
            'description': description,
            'performance_marker': True,
        }
        
        if potential_savings:
            log_data['potential_savings'] = potential_savings
        
        log_data.update(kwargs)
        
        self.logger.info(
            f"Optimization opportunity: {opportunity_type}",
            extra=self._add_correlation_id(log_data)
        )


def structured_logging_decorator(operation: str):
    """Decorator to add structured logging to Lambda functions."""
    def decorator(func):
        @wraps(func)
        def wrapper(event, context):
            # Extract correlation ID from headers
            correlation_id = event.get('headers', {}).get('x-correlation-id') or str(uuid.uuid4())
            
            # Create structured logger
            logger = AuthStructuredLogger(context, correlation_id)
            
            # Log function start
            start_time = time.time()
            logger.log_function_start(context.function_name, event)
            
            try:
                # Execute function
                result = func(event, context)
                
                # Log function end
                duration = time.time() - start_time
                status_code = result.get('statusCode', 500)
                success = status_code < 400
                
                logger.log_function_end(context.function_name, duration, status_code, success)
                
                # Add correlation ID to response headers
                if 'headers' not in result:
                    result['headers'] = {}
                result['headers']['x-correlation-id'] = correlation_id
                
                return result
                
            except Exception as e:
                # Log function error
                duration = time.time() - start_time
                logger.log_function_end(context.function_name, duration, 500, False)
                
                logger.logger.error(
                    f"Function {context.function_name} failed",
                    extra=logger._add_correlation_id({
                        'error': str(e),
                        'error_type': type(e).__name__,
                        'duration_ms': round(duration * 1000, 2),
                        'performance_marker': True,
                    })
                )
                
                raise
        
        return wrapper
    return decorator