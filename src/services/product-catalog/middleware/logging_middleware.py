"""
Enhanced logging middleware for product catalog service with structured logging and performance markers
"""

import logging
import json
import uuid
import time
from contextvars import ContextVar
from typing import Dict, Any, Optional
from datetime import datetime

from fastapi import Request, Response
import structlog

# Context variable for correlation ID
correlation_id_var: ContextVar[str] = ContextVar('correlation_id', default='')

# Context variable for request start time
request_start_time_var: ContextVar[float] = ContextVar('request_start_time', default=0.0)


def get_correlation_id() -> str:
    """Get the current correlation ID from context."""
    return correlation_id_var.get() or str(uuid.uuid4())


def set_correlation_id(correlation_id: str) -> None:
    """Set the correlation ID in context."""
    correlation_id_var.set(correlation_id)


def get_request_start_time() -> float:
    """Get the request start time from context."""
    return request_start_time_var.get()


def set_request_start_time(start_time: float) -> None:
    """Set the request start time in context."""
    request_start_time_var.set(start_time)


class CorrelationIdProcessor:
    """Structlog processor to add correlation ID to log records."""
    
    def __call__(self, logger, method_name, event_dict):
        event_dict['correlation_id'] = get_correlation_id()
        
        # Add request duration if available
        start_time = get_request_start_time()
        if start_time > 0:
            event_dict['request_duration_ms'] = round((time.time() - start_time) * 1000, 2)
        
        return event_dict


class PerformanceMarkerProcessor:
    """Structlog processor to add performance markers."""
    
    def __call__(self, logger, method_name, event_dict):
        # Add service identifier
        event_dict['service'] = 'product-catalog'
        
        # Add timestamp in ISO format
        event_dict['timestamp'] = datetime.utcnow().isoformat() + 'Z'
        
        # Mark performance-related logs
        if any(keyword in str(event_dict.get('event', '')).lower() 
               for keyword in ['slow', 'performance', 'duration', 'timeout', 'optimization', 'cache']):
            event_dict['performance_marker'] = True
        
        return event_dict


class JSONFormatter(logging.Formatter):
    """Enhanced JSON formatter for structured logging."""
    
    def format(self, record):
        """Format log record as JSON with enhanced fields."""
        log_entry = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
            'service': 'product-catalog',
        }
        
        # Add correlation ID if available
        correlation_id = getattr(record, 'correlation_id', None) or get_correlation_id()
        if correlation_id:
            log_entry['correlation_id'] = correlation_id
        
        # Add request duration if available
        start_time = get_request_start_time()
        if start_time > 0:
            log_entry['request_duration_ms'] = round((time.time() - start_time) * 1000, 2)
        
        # Add extra fields from the record
        for key, value in record.__dict__.items():
            if key not in ['name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 
                          'filename', 'module', 'lineno', 'funcName', 'created', 
                          'msecs', 'relativeCreated', 'thread', 'threadName', 
                          'processName', 'process', 'getMessage', 'exc_info', 
                          'exc_text', 'stack_info', 'correlation_id']:
                log_entry[key] = value
        
        # Add exception info if present
        if record.exc_info:
            log_entry['exception'] = self.formatException(record.exc_info)
            log_entry['error'] = True
        
        # Mark performance-related logs
        if any(keyword in record.getMessage().lower() 
               for keyword in ['slow', 'performance', 'duration', 'timeout', 'optimization', 'cache']):
            log_entry['performance_marker'] = True
        
        return json.dumps(log_entry, default=str)


def setup_logging(log_level: str = "INFO") -> logging.Logger:
    """Set up enhanced structured logging configuration."""
    
    # Configure structlog
    structlog.configure(
        processors=[
            CorrelationIdProcessor(),
            PerformanceMarkerProcessor(),
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer()
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    
    # Configure standard logging
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format='%(message)s',
        handlers=[
            logging.StreamHandler()
        ]
    )
    
    # Set up JSON formatter for the root logger
    root_logger = logging.getLogger()
    for handler in root_logger.handlers:
        handler.setFormatter(JSONFormatter())
    
    # Configure specific loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)
    logging.getLogger("redis").setLevel(logging.INFO)
    
    return logging.getLogger(__name__)


async def correlation_id_middleware(request: Request, call_next):
    """Enhanced middleware to handle correlation ID and request tracking."""
    
    # Get correlation ID from header or generate new one
    correlation_id = request.headers.get('x-correlation-id') or str(uuid.uuid4())
    
    # Set correlation ID and start time in context
    set_correlation_id(correlation_id)
    start_time = time.time()
    set_request_start_time(start_time)
    
    # Get structured logger
    logger = structlog.get_logger()
    
    # Log request start
    logger.info(
        "Request started",
        method=request.method,
        path=str(request.url.path),
        query_params=dict(request.query_params),
        user_agent=request.headers.get('user-agent', ''),
        client_ip=request.client.host if request.client else None,
    )
    
    try:
        # Process request
        response = await call_next(request)
        
        # Calculate duration
        duration = time.time() - start_time
        
        # Log request completion
        logger.info(
            "Request completed",
            method=request.method,
            path=str(request.url.path),
            status_code=response.status_code,
            duration_ms=round(duration * 1000, 2),
            performance_marker=duration > 2.0,  # Mark slow requests (2s threshold for search)
        )
        
        # Add correlation ID to response headers
        response.headers['x-correlation-id'] = correlation_id
        
        return response
        
    except Exception as e:
        # Calculate duration
        duration = time.time() - start_time
        
        # Log request error
        logger.error(
            "Request failed",
            method=request.method,
            path=str(request.url.path),
            error=str(e),
            error_type=type(e).__name__,
            duration_ms=round(duration * 1000, 2),
            performance_marker=True,  # Mark all errors as performance issues
        )
        
        raise


class CatalogStructuredLogger:
    """Helper class for structured logging with catalog-specific patterns."""
    
    def __init__(self, name: str):
        self.logger = structlog.get_logger(name)
    
    def log_database_query(self, query_type: str, duration: float, result_count: Optional[int] = None,
                          cache_hit: Optional[bool] = None, optimization_opportunity: bool = False):
        """Log database queries with consistent structure."""
        self.logger.info(
            f"Database query: {query_type}",
            query_type=query_type,
            duration_ms=round(duration * 1000, 2),
            result_count=result_count,
            cache_hit=cache_hit,
            performance_marker=duration > 0.5 or optimization_opportunity,  # Mark slow queries
            optimization_opportunity=optimization_opportunity,
        )
    
    def log_cache_operation(self, operation: str, cache_type: str, key: str, hit: bool, 
                           duration: Optional[float] = None):
        """Log cache operations with consistent structure."""
        log_data = {
            "operation": operation,
            "cache_type": cache_type,
            "cache_key": key,
            "cache_hit": hit,
        }
        
        if duration is not None:
            log_data["duration_ms"] = round(duration * 1000, 2)
            log_data["performance_marker"] = duration > 0.1  # Mark slow cache operations
        
        self.logger.info(f"Cache {operation}", **log_data)
    
    def log_search_operation(self, query: str, result_count: int, duration: float, 
                            cache_hit: bool = False, filters_applied: Optional[Dict] = None):
        """Log search operations with consistent structure."""
        self.logger.info(
            "Product search",
            search_query=query,
            result_count=result_count,
            duration_ms=round(duration * 1000, 2),
            cache_hit=cache_hit,
            filters=filters_applied or {},
            performance_marker=duration > 2.0,  # Mark slow searches
            optimization_opportunity=duration > 1.0 and not cache_hit,
        )
    
    def log_connection_pool_status(self, active_connections: int, pool_size: int, 
                                  queue_size: int = 0):
        """Log database connection pool status."""
        utilization = (active_connections / pool_size) * 100 if pool_size > 0 else 0
        
        self.logger.info(
            "Connection pool status",
            active_connections=active_connections,
            pool_size=pool_size,
            queue_size=queue_size,
            utilization_percent=round(utilization, 2),
            performance_marker=utilization > 80,  # Mark high utilization
            optimization_opportunity=utilization > 90,
        )
    
    def log_cache_warming(self, cache_type: str, items_warmed: int, duration: float):
        """Log cache warming operations."""
        self.logger.info(
            "Cache warming completed",
            cache_type=cache_type,
            items_warmed=items_warmed,
            duration_ms=round(duration * 1000, 2),
            performance_marker=True,  # Always mark cache warming as performance-related
        )
    
    def log_optimization_opportunity(self, opportunity_type: str, description: str, 
                                   potential_improvement: str, **kwargs):
        """Log optimization opportunities with consistent structure."""
        self.logger.info(
            f"Optimization opportunity: {opportunity_type}",
            optimization_type=opportunity_type,
            description=description,
            potential_improvement=potential_improvement,
            performance_marker=True,
            **kwargs
        )
    
    def log_performance_issue(self, issue_type: str, description: str, 
                             impact: str, **kwargs):
        """Log performance issues with consistent structure."""
        self.logger.warning(
            f"Performance issue: {issue_type}",
            issue_type=issue_type,
            description=description,
            impact=impact,
            performance_marker=True,
            **kwargs
        )