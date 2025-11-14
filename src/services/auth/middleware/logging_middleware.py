"""
Logging middleware for User Authentication Service
Provides structured logging with Dynatrace integration
"""

import logging
import json
import time
from flask import request, g
from datetime import datetime


def setup_logging(app):
    """Setup structured logging for the Flask app"""
    
    # Configure logging format
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    logger = logging.getLogger(__name__)
    
    @app.before_request
    def before_request():
        """Log request start and setup request context"""
        g.start_time = time.time()
        g.request_id = request.headers.get('X-Request-ID', f"req_{int(time.time() * 1000)}")
        
        # Log incoming request
        logger.info(json.dumps({
            'event': 'request_start',
            'request_id': g.request_id,
            'method': request.method,
            'path': request.path,
            'remote_addr': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', ''),
            'timestamp': datetime.now().isoformat()
        }))
    
    @app.after_request
    def after_request(response):
        """Log request completion"""
        duration = time.time() - g.start_time
        
        logger.info(json.dumps({
            'event': 'request_complete',
            'request_id': g.request_id,
            'method': request.method,
            'path': request.path,
            'status_code': response.status_code,
            'duration_ms': round(duration * 1000, 2),
            'response_size': len(response.get_data()),
            'timestamp': datetime.now().isoformat()
        }))
        
        return response
    
    @app.errorhandler(Exception)
    def handle_exception(e):
        """Log unhandled exceptions"""
        logger.error(json.dumps({
            'event': 'unhandled_exception',
            'request_id': getattr(g, 'request_id', 'unknown'),
            'method': request.method,
            'path': request.path,
            'error_type': type(e).__name__,
            'error_message': str(e),
            'timestamp': datetime.now().isoformat()
        }))
        
        # Re-raise the exception to let Flask handle it
        raise e


def log_user_action(action: str, user_id: str = None, details: dict = None):
    """Log user actions for audit trail"""
    logger = logging.getLogger(__name__)
    
    log_data = {
        'event': 'user_action',
        'action': action,
        'user_id': user_id,
        'request_id': getattr(g, 'request_id', 'unknown'),
        'timestamp': datetime.now().isoformat()
    }
    
    if details:
        log_data['details'] = details
    
    logger.info(json.dumps(log_data))


def log_security_event(event_type: str, user_id: str = None, details: dict = None):
    """Log security-related events"""
    logger = logging.getLogger(__name__)
    
    log_data = {
        'event': 'security_event',
        'event_type': event_type,
        'user_id': user_id,
        'request_id': getattr(g, 'request_id', 'unknown'),
        'remote_addr': request.remote_addr,
        'user_agent': request.headers.get('User-Agent', ''),
        'timestamp': datetime.now().isoformat()
    }
    
    if details:
        log_data['details'] = details
    
    logger.warning(json.dumps(log_data))


def log_database_operation(operation: str, table: str, duration: float = None, success: bool = True, error: str = None):
    """Log database operations"""
    logger = logging.getLogger(__name__)
    
    log_data = {
        'event': 'database_operation',
        'operation': operation,
        'table': table,
        'success': success,
        'request_id': getattr(g, 'request_id', 'unknown'),
        'timestamp': datetime.now().isoformat()
    }
    
    if duration is not None:
        log_data['duration_ms'] = round(duration * 1000, 2)
    
    if error:
        log_data['error'] = error
    
    if success:
        logger.info(json.dumps(log_data))
    else:
        logger.error(json.dumps(log_data))