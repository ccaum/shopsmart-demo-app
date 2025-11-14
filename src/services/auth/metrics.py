"""
CloudWatch custom metrics for authentication service
"""

import json
import boto3
import time
import logging
from typing import Dict, Any, Optional
from datetime import datetime
from functools import wraps

logger = logging.getLogger(__name__)

class AuthMetrics:
    """CloudWatch metrics collector for authentication service"""
    
    def __init__(self, namespace: str = "ShopSmart/Auth"):
        self.namespace = namespace
        self.cloudwatch = None
        
        try:
            self.cloudwatch = boto3.client('cloudwatch')
        except Exception as e:
            logger.warning(f"Failed to initialize CloudWatch client: {e}")
    
    def put_metric(self, metric_name: str, value: float, unit: str = 'Count', 
                   dimensions: Optional[Dict[str, str]] = None):
        """Put a single metric to CloudWatch"""
        if not self.cloudwatch:
            return
        
        try:
            metric_data = {
                'MetricName': metric_name,
                'Value': value,
                'Unit': unit,
                'Timestamp': datetime.utcnow()
            }
            
            if dimensions:
                metric_data['Dimensions'] = [
                    {'Name': k, 'Value': v} for k, v in dimensions.items()
                ]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[metric_data]
            )
            
        except Exception as e:
            logger.warning(f"Failed to send metric {metric_name}: {e}")
    
    def record_login_attempt(self, success: bool, duration: float):
        """Record login attempt metrics"""
        # Login success rate
        self.put_metric('LoginAttempts', 1, 'Count', {'Status': 'Success' if success else 'Failed'})
        
        # Login duration
        self.put_metric('LoginDuration', duration * 1000, 'Milliseconds')
        
        # Success rate calculation
        if success:
            self.put_metric('LoginSuccessRate', 1, 'Count')
        else:
            self.put_metric('LoginFailureRate', 1, 'Count')
    
    def record_registration_attempt(self, success: bool, duration: float):
        """Record registration attempt metrics"""
        self.put_metric('RegistrationAttempts', 1, 'Count', {'Status': 'Success' if success else 'Failed'})
        self.put_metric('RegistrationDuration', duration * 1000, 'Milliseconds')
    
    def record_session_validation(self, success: bool, duration: float):
        """Record session validation metrics"""
        self.put_metric('SessionValidations', 1, 'Count', {'Status': 'Valid' if success else 'Invalid'})
        self.put_metric('SessionValidationDuration', duration * 1000, 'Milliseconds')
    
    def record_cart_operation(self, operation: str, success: bool, duration: float, item_count: int = 0):
        """Record cart operation metrics"""
        dimensions = {'Operation': operation, 'Status': 'Success' if success else 'Failed'}
        
        self.put_metric('CartOperations', 1, 'Count', dimensions)
        self.put_metric('CartOperationDuration', duration * 1000, 'Milliseconds', {'Operation': operation})
        
        if operation == 'get' and success:
            self.put_metric('CartItemCount', item_count, 'Count')
    
    def record_dynamodb_throttle(self, table_name: str):
        """Record DynamoDB throttling events"""
        self.put_metric('DynamoDBThrottles', 1, 'Count', {'TableName': table_name})
    
    def record_error(self, error_type: str, function_name: str):
        """Record error metrics"""
        dimensions = {'ErrorType': error_type, 'Function': function_name}
        self.put_metric('Errors', 1, 'Count', dimensions)


def metrics_decorator(operation: str):
    """Decorator to automatically record metrics for Lambda functions"""
    def decorator(func):
        @wraps(func)
        def wrapper(event, context):
            metrics = AuthMetrics()
            start_time = time.time()
            success = False
            
            try:
                result = func(event, context)
                success = result.get('statusCode', 500) < 400
                return result
                
            except Exception as e:
                metrics.record_error(type(e).__name__, context.function_name)
                raise
                
            finally:
                duration = time.time() - start_time
                
                # Record operation-specific metrics
                if operation == 'login':
                    metrics.record_login_attempt(success, duration)
                elif operation == 'register':
                    metrics.record_registration_attempt(success, duration)
                elif operation == 'validate':
                    metrics.record_session_validation(success, duration)
                elif operation.startswith('cart'):
                    item_count = 0
                    if success and operation == 'cart_get':
                        try:
                            body = json.loads(result.get('body', '{}'))
                            item_count = body.get('itemCount', 0)
                        except:
                            pass
                    metrics.record_cart_operation(operation.replace('cart_', ''), success, duration, item_count)
        
        return wrapper
    return decorator