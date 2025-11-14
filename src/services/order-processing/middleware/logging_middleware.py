"""
Enhanced logging middleware for structured logging with correlation IDs and performance markers
"""

import logging
import json
import uuid
import time
import os
import requests
from contextvars import ContextVar
from typing import Dict, Any, Optional
from datetime import datetime

from fastapi import Request, Response
import structlog

# Context variable for correlation ID
correlation_id_var: ContextVar[str] = ContextVar('correlation_id', default='')

# Context variable for request start time
request_start_time_var: ContextVar[float] = ContextVar('request_start_time', default=0.0)


class OTLPHttpHandler(logging.Handler):
    """Handler that sends logs to OTEL Collector via HTTP."""
    
    def __init__(self, endpoint: str, service_name: str):
        super().__init__()
        self.endpoint = f"{endpoint}/v1/logs"
        self.service_name = service_name
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
    
    def emit(self, record):
        try:
            log_data = {
                "resourceLogs": [{
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"stringValue": self.service_name}},
                            {"key": "service.instance.id", "value": {"stringValue": os.getenv("HOSTNAME", "unknown")}},
                        ]
                    },
                    "scopeLogs": [{
                        "scope": {
                            "name": record.name
                        },
                        "logRecords": [{
                            "timeUnixNano": str(int(record.created * 1_000_000_000)),
                            "severityNumber": self._get_severity_number(record.levelno),
                            "severityText": record.levelname,
                            "body": {"stringValue": record.getMessage()},
                            "attributes": [
                                {"key": "logger", "value": {"stringValue": record.name}},
                                {"key": "module", "value": {"stringValue": record.module}},
                                {"key": "function", "value": {"stringValue": record.funcName}},
                                {"key": "line", "value": {"intValue": str(record.lineno)}},
                            ]
                        }]
                    }]
                }]
            }
            
            # Add correlation ID if present
            correlation_id = correlation_id_var.get()
            if correlation_id:
                log_data["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"].append(
                    {"key": "correlation.id", "value": {"stringValue": correlation_id}}
                )
            
            self.session.post(self.endpoint, json=log_data, timeout=2)
        except Exception:
            pass  # Silently fail to avoid logging loops
    
    def _get_severity_number(self, levelno):
        """Map Python log level to OTEL severity number."""
        if levelno >= 50:  # CRITICAL
            return 21
        elif levelno >= 40:  # ERROR
            return 17
        elif levelno >= 30:  # WARNING
            return 13
        elif levelno >= 20:  # INFO
            return 9
        else:  # DEBUG
            return 5


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
        event_dict['service'] = 'order-processing'
        
        # Add timestamp in ISO format
        event_dict['timestamp'] = datetime.utcnow().isoformat() + 'Z'
        
        # Mark performance-related logs
        if any(keyword in str(event_dict.get('event', '')).lower() 
               for keyword in ['slow', 'performance', 'duration', 'timeout', 'optimization']):
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
            'service': 'order-processing',
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
               for keyword in ['slow', 'performance', 'duration', 'timeout', 'optimization']):
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
    
    # Add OTLP handler if endpoint is configured
    otel_endpoint = os.getenv('OTEL_EXPORTER_OTLP_ENDPOINT')
    service_name = os.getenv('OTEL_SERVICE_NAME', 'order-processing-service')
    if otel_endpoint:
        otlp_handler = OTLPHttpHandler(otel_endpoint, service_name)
        otlp_handler.setLevel(logging.INFO)
        root_logger.addHandler(otlp_handler)
    
    # Configure specific loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("pymongo").setLevel(logging.INFO)
    
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
            performance_marker=duration > 1.0,  # Mark slow requests
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


class StructuredLogger:
    """Helper class for structured logging with common patterns."""
    
    def __init__(self, name: str):
        self.logger = structlog.get_logger(name)
    
    def log_database_operation(self, operation: str, collection: str, duration: float, 
                              success: bool, result_count: Optional[int] = None):
        """Log database operations with consistent structure."""
        self.logger.info(
            f"Database {operation}",
            operation=operation,
            collection=collection,
            duration_ms=round(duration * 1000, 2),
            success=success,
            result_count=result_count,
            performance_marker=duration > 0.5,  # Mark slow queries
        )
    
    def log_service_call(self, service: str, endpoint: str, duration: float, 
                        status_code: int, success: bool):
        """Log service-to-service calls with consistent structure."""
        self.logger.info(
            f"Service call to {service}",
            service=service,
            endpoint=endpoint,
            duration_ms=round(duration * 1000, 2),
            status_code=status_code,
            success=success,
            performance_marker=duration > 2.0,  # Mark slow service calls
        )
    
    def log_business_event(self, event: str, **kwargs):
        """Log business events with consistent structure."""
        self.logger.info(
            f"Business event: {event}",
            event_type="business",
            event_name=event,
            **kwargs
        )
    
    def log_performance_issue(self, issue: str, **kwargs):
        """Log performance issues with consistent structure."""
        self.logger.warning(
            f"Performance issue: {issue}",
            issue_type="performance",
            issue_description=issue,
            performance_marker=True,
            **kwargs
        )
    
    def log_optimization_opportunity(self, opportunity: str, **kwargs):
        """Log optimization opportunities with consistent structure."""
        self.logger.info(
            f"Optimization opportunity: {opportunity}",
            optimization_type="opportunity",
            description=opportunity,
            performance_marker=True,
            **kwargs
        )