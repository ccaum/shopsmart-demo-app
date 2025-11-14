"""
Enhanced metrics middleware for order processing service
"""

import time
import boto3
import logging
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Dict, Any, Optional
import json

logger = logging.getLogger(__name__)

class OrderMetricsMiddleware(BaseHTTPMiddleware):
    """Enhanced middleware for collecting order processing metrics"""
    
    def __init__(self, app):
        super().__init__(app)
        self.cloudwatch = None
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.namespace = "ShopSmart/Orders"
        
        try:
            self.cloudwatch = boto3.client('cloudwatch')
        except Exception as e:
            logger.warning(f"Failed to initialize CloudWatch client: {e}")
    
    async def dispatch(self, request: Request, call_next):
        start_time = time.time()
        
        try:
            response = await call_next(request)
            duration = time.time() - start_time
            
            # Send metrics asynchronously
            if self.cloudwatch:
                asyncio.create_task(
                    self._send_metrics_async(
                        request.method,
                        request.url.path,
                        response.status_code,
                        duration,
                        request,
                        response
                    )
                )
            
            return response
            
        except Exception as e:
            duration = time.time() - start_time
            
            # Send error metrics
            if self.cloudwatch:
                asyncio.create_task(
                    self._send_error_metrics_async(
                        request.method,
                        request.url.path,
                        duration
                    )
                )
            
            raise
    
    async def _send_metrics_async(self, method: str, path: str, status_code: int, 
                                  duration: float, request: Request, response):
        """Send metrics to CloudWatch asynchronously"""
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                self.executor,
                self._send_metrics,
                method,
                path,
                status_code,
                duration,
                request,
                response
            )
        except Exception as e:
            logger.warning(f"Failed to send metrics: {e}")
    
    async def _send_error_metrics_async(self, method: str, path: str, duration: float):
        """Send error metrics to CloudWatch asynchronously"""
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                self.executor,
                self._send_error_metrics,
                method,
                path,
                duration
            )
        except Exception as e:
            logger.warning(f"Failed to send error metrics: {e}")
    
    def _send_metrics(self, method: str, path: str, status_code: int, duration: float, 
                      request: Request, response):
        """Send enhanced metrics to CloudWatch"""
        try:
            metrics_data = [
                {
                    'MetricName': 'RequestCount',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path},
                        {'Name': 'StatusCode', 'Value': str(status_code)}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                },
                {
                    'MetricName': 'ResponseTime',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path}
                    ],
                    'Value': duration * 1000,  # Convert to milliseconds
                    'Unit': 'Milliseconds',
                    'Timestamp': datetime.utcnow()
                }
            ]
            
            # Add success/error metrics
            if status_code < 400:
                metrics_data.append({
                    'MetricName': 'OrderSuccessRate',
                    'Dimensions': [
                        {'Name': 'Operation', 'Value': self._get_operation_type(path, method)}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            else:
                metrics_data.append({
                    'MetricName': 'OrderErrorRate',
                    'Dimensions': [
                        {'Name': 'Operation', 'Value': self._get_operation_type(path, method)},
                        {'Name': 'StatusCode', 'Value': str(status_code)}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            # Add order-specific metrics
            if method == 'POST' and '/orders' in path and status_code == 201:
                metrics_data.extend([
                    {
                        'MetricName': 'OrdersCreated',
                        'Value': 1,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'OrderProcessingDuration',
                        'Value': duration * 1000,
                        'Unit': 'Milliseconds',
                        'Timestamp': datetime.utcnow()
                    }
                ])
            
            # Add order history metrics
            if method == 'GET' and '/orders/' in path and status_code == 200:
                metrics_data.append({
                    'MetricName': 'OrderHistoryRequests',
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics_data
            )
            
        except Exception as e:
            logger.warning(f"Failed to send CloudWatch metrics: {e}")
    
    def _send_error_metrics(self, method: str, path: str, duration: float):
        """Send error metrics to CloudWatch"""
        try:
            metrics_data = [
                {
                    'MetricName': 'RequestCount',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path},
                        {'Name': 'StatusCode', 'Value': '500'}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                },
                {
                    'MetricName': 'OrderErrorRate',
                    'Dimensions': [
                        {'Name': 'Operation', 'Value': self._get_operation_type(path, method)},
                        {'Name': 'StatusCode', 'Value': '500'}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                },
                {
                    'MetricName': 'ResponseTime',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path}
                    ],
                    'Value': duration * 1000,
                    'Unit': 'Milliseconds',
                    'Timestamp': datetime.utcnow()
                }
            ]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics_data
            )
            
        except Exception as e:
            logger.warning(f"Failed to send error metrics: {e}")
    
    def _get_operation_type(self, path: str, method: str) -> str:
        """Determine operation type from path and method"""
        if method == 'POST' and path == '/orders':
            return 'create'
        elif method == 'GET' and '/orders/' in path:
            return 'retrieve'
        elif method == 'PUT' and '/orders/' in path:
            return 'update'
        else:
            return 'other'


class OrderMetrics:
    """Additional metrics collector for order processing specific metrics"""
    
    def __init__(self, namespace: str = "ShopSmart/Orders"):
        self.namespace = namespace
        self.cloudwatch = None
        
        try:
            self.cloudwatch = boto3.client('cloudwatch')
        except Exception as e:
            logger.warning(f"Failed to initialize CloudWatch client: {e}")
    
    def record_order_creation(self, success: bool, duration: float, order_value: float = 0, 
                             item_count: int = 0, validation_failures: int = 0):
        """Record order creation metrics"""
        if not self.cloudwatch:
            return
        
        try:
            metrics_data = [
                {
                    'MetricName': 'OrderCreationAttempts',
                    'Dimensions': [
                        {'Name': 'Status', 'Value': 'Success' if success else 'Failed'}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                },
                {
                    'MetricName': 'OrderCreationDuration',
                    'Value': duration * 1000,
                    'Unit': 'Milliseconds',
                    'Timestamp': datetime.utcnow()
                }
            ]
            
            if success:
                metrics_data.extend([
                    {
                        'MetricName': 'OrderValue',
                        'Value': order_value,
                        'Unit': 'None',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'OrderItemCount',
                        'Value': item_count,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    }
                ])
            
            if validation_failures > 0:
                metrics_data.append({
                    'MetricName': 'InventoryValidationFailures',
                    'Value': validation_failures,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics_data
            )
        except Exception as e:
            logger.warning(f"Failed to send order creation metrics: {e}")
    
    def record_inventory_validation(self, duration: float, items_checked: int, failures: int):
        """Record inventory validation metrics"""
        if not self.cloudwatch:
            return
        
        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'InventoryValidationDuration',
                        'Value': duration * 1000,
                        'Unit': 'Milliseconds',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'InventoryItemsChecked',
                        'Value': items_checked,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'InventoryValidationFailures',
                        'Value': failures,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.warning(f"Failed to send inventory validation metrics: {e}")
    
    def record_mongodb_operation(self, operation: str, duration: float, success: bool):
        """Record MongoDB operation metrics"""
        if not self.cloudwatch:
            return
        
        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'MongoDBOperations',
                        'Dimensions': [
                            {'Name': 'Operation', 'Value': operation},
                            {'Name': 'Status', 'Value': 'Success' if success else 'Failed'}
                        ],
                        'Value': 1,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'MongoDBOperationDuration',
                        'Dimensions': [
                            {'Name': 'Operation', 'Value': operation}
                        ],
                        'Value': duration * 1000,
                        'Unit': 'Milliseconds',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.warning(f"Failed to send MongoDB metrics: {e}")
    
    def record_service_communication(self, service: str, operation: str, duration: float, success: bool):
        """Record cross-service communication metrics"""
        if not self.cloudwatch:
            return
        
        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'ServiceCommunication',
                        'Dimensions': [
                            {'Name': 'Service', 'Value': service},
                            {'Name': 'Operation', 'Value': operation},
                            {'Name': 'Status', 'Value': 'Success' if success else 'Failed'}
                        ],
                        'Value': 1,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'ServiceCommunicationDuration',
                        'Dimensions': [
                            {'Name': 'Service', 'Value': service},
                            {'Name': 'Operation', 'Value': operation}
                        ],
                        'Value': duration * 1000,
                        'Unit': 'Milliseconds',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.warning(f"Failed to send service communication metrics: {e}")