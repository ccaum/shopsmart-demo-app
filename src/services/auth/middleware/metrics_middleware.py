"""
Metrics middleware for User Authentication Service
Provides custom metrics collection for Dynatrace integration
"""

import time
import json
from flask import request, g
from datetime import datetime
from typing import Dict, Any


class MetricsCollector:
    """Collect and track custom metrics"""
    
    def __init__(self):
        self.metrics = {}
    
    def increment_counter(self, metric_name: str, tags: Dict[str, str] = None):
        """Increment a counter metric"""
        key = f"{metric_name}:{json.dumps(tags or {}, sort_keys=True)}"
        self.metrics[key] = self.metrics.get(key, 0) + 1
    
    def record_gauge(self, metric_name: str, value: float, tags: Dict[str, str] = None):
        """Record a gauge metric"""
        key = f"{metric_name}:{json.dumps(tags or {}, sort_keys=True)}"
        self.metrics[key] = value
    
    def record_histogram(self, metric_name: str, value: float, tags: Dict[str, str] = None):
        """Record a histogram metric (for timing data)"""
        key = f"{metric_name}:{json.dumps(tags or {}, sort_keys=True)}"
        if key not in self.metrics:
            self.metrics[key] = []
        self.metrics[key].append(value)
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get all collected metrics"""
        return self.metrics.copy()
    
    def reset_metrics(self):
        """Reset all metrics"""
        self.metrics.clear()


# Global metrics collector
metrics_collector = MetricsCollector()


def setup_metrics(app):
    """Setup metrics collection for the Flask app"""
    
    @app.before_request
    def before_request_metrics():
        """Setup metrics collection for request"""
        g.metrics_start_time = time.time()
    
    @app.after_request
    def after_request_metrics(response):
        """Collect metrics after request completion"""
        duration = time.time() - g.metrics_start_time
        
        # Record request metrics
        tags = {
            'method': request.method,
            'endpoint': request.endpoint or 'unknown',
            'status_code': str(response.status_code)
        }
        
        metrics_collector.increment_counter('auth_requests_total', tags)
        metrics_collector.record_histogram('auth_request_duration_seconds', duration, tags)
        
        # Record response size
        response_size = len(response.get_data())
        metrics_collector.record_histogram('auth_response_size_bytes', response_size, tags)
        
        return response


def track_user_registration():
    """Track user registration metrics"""
    metrics_collector.increment_counter('auth_user_registrations_total')


def track_user_login(success: bool = True):
    """Track user login metrics"""
    tags = {'success': str(success).lower()}
    metrics_collector.increment_counter('auth_user_logins_total', tags)


def track_session_validation(success: bool = True):
    """Track session validation metrics"""
    tags = {'success': str(success).lower()}
    metrics_collector.increment_counter('auth_session_validations_total', tags)


def track_cart_operation(operation: str, success: bool = True):
    """Track shopping cart operations"""
    tags = {
        'operation': operation,
        'success': str(success).lower()
    }
    metrics_collector.increment_counter('auth_cart_operations_total', tags)


def track_profile_update(success: bool = True):
    """Track profile update operations"""
    tags = {'success': str(success).lower()}
    metrics_collector.increment_counter('auth_profile_updates_total', tags)


def track_database_operation(table: str, operation: str, duration: float, success: bool = True):
    """Track database operation metrics"""
    tags = {
        'table': table,
        'operation': operation,
        'success': str(success).lower()
    }
    
    metrics_collector.increment_counter('auth_database_operations_total', tags)
    metrics_collector.record_histogram('auth_database_operation_duration_seconds', duration, tags)


def track_authentication_failure(reason: str):
    """Track authentication failures"""
    tags = {'reason': reason}
    metrics_collector.increment_counter('auth_authentication_failures_total', tags)


def track_cart_size(user_id: str, item_count: int, total_value: float):
    """Track shopping cart metrics"""
    metrics_collector.record_gauge('auth_cart_items_count', item_count, {'user_id': user_id})
    metrics_collector.record_gauge('auth_cart_total_value', total_value, {'user_id': user_id})


def track_user_activity(user_id: str, activity_type: str):
    """Track user activity metrics"""
    tags = {
        'user_id': user_id,
        'activity_type': activity_type
    }
    metrics_collector.increment_counter('auth_user_activities_total', tags)


def get_service_metrics() -> Dict[str, Any]:
    """Get all service metrics for reporting"""
    return {
        'timestamp': datetime.now().isoformat(),
        'service': 'user-auth',
        'metrics': metrics_collector.get_metrics()
    }


def reset_service_metrics():
    """Reset all service metrics"""
    metrics_collector.reset_metrics()


# Custom metric decorators
def track_execution_time(metric_name: str, tags: Dict[str, str] = None):
    """Decorator to track function execution time"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = func(*args, **kwargs)
                duration = time.time() - start_time
                metrics_collector.record_histogram(metric_name, duration, tags)
                return result
            except Exception as e:
                duration = time.time() - start_time
                error_tags = (tags or {}).copy()
                error_tags['error'] = type(e).__name__
                metrics_collector.record_histogram(f"{metric_name}_error", duration, error_tags)
                raise
        return wrapper
    return decorator


def track_function_calls(metric_name: str, tags: Dict[str, str] = None):
    """Decorator to track function call counts"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                result = func(*args, **kwargs)
                success_tags = (tags or {}).copy()
                success_tags['success'] = 'true'
                metrics_collector.increment_counter(metric_name, success_tags)
                return result
            except Exception as e:
                error_tags = (tags or {}).copy()
                error_tags['success'] = 'false'
                error_tags['error'] = type(e).__name__
                metrics_collector.increment_counter(metric_name, error_tags)
                raise
        return wrapper
    return decorator