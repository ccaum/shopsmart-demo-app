"""
CloudWatch Metrics Middleware
Publishes custom application metrics to CloudWatch
"""

import os
import time
import logging
from typing import Dict, Any, Optional
from datetime import datetime

import boto3
from botocore.exceptions import ClientError
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


class CloudWatchMetricsMiddleware(BaseHTTPMiddleware):
    """Middleware to publish custom metrics to CloudWatch"""
    
    def __init__(self, app, namespace: str = None):
        super().__init__(app)
        self.namespace = namespace or os.environ.get('CLOUDWATCH_NAMESPACE', 'ShopSmart/OrderProcessing')
        self.enabled = os.environ.get('CLOUDWATCH_METRICS_ENABLED', 'true').lower() == 'true'
        
        if self.enabled:
            try:
                self.cloudwatch = boto3.client('cloudwatch')
                logger.info(f"CloudWatch metrics enabled for namespace: {self.namespace}")
            except Exception as e:
                logger.error(f"Failed to initialize CloudWatch client: {e}")
                self.enabled = False
        else:
            logger.info("CloudWatch metrics disabled")
    
    async def dispatch(self, request: Request, call_next):
        if not self.enabled:
            return await call_next(request)
        
        start_time = time.time()
        
        try:
            response = await call_next(request)
            
            # Calculate request duration
            duration = (time.time() - start_time) * 1000  # Convert to milliseconds
            
            # Publish metrics asynchronously
            await self._publish_request_metrics(request, response, duration)
            
            return response
            
        except Exception as e:
            # Publish error metrics
            duration = (time.time() - start_time) * 1000
            await self._publish_error_metrics(request, str(e), duration)
            raise
    
    async def _publish_request_metrics(self, request: Request, response: Response, duration: float):
        """Publish request-level metrics to CloudWatch"""
        try:
            metrics = []
            
            # Request duration metric
            metrics.append({
                'MetricName': 'RequestDuration',
                'Value': duration,
                'Unit': 'Milliseconds',
                'Dimensions': [
                    {'Name': 'Endpoint', 'Value': request.url.path},
                    {'Name': 'Method', 'Value': request.method},
                    {'Name': 'StatusCode', 'Value': str(response.status_code)}
                ]
            })
            
            # Request count metric
            metrics.append({
                'MetricName': 'RequestCount',
                'Value': 1,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Endpoint', 'Value': request.url.path},
                    {'Name': 'Method', 'Value': request.method},
                    {'Name': 'StatusCode', 'Value': str(response.status_code)}
                ]
            })
            
            # Error rate metrics
            if response.status_code >= 400:
                metrics.append({
                    'MetricName': 'ErrorCount',
                    'Value': 1,
                    'Unit': 'Count',
                    'Dimensions': [
                        {'Name': 'Endpoint', 'Value': request.url.path},
                        {'Name': 'StatusCode', 'Value': str(response.status_code)}
                    ]
                })
            
            # Publish metrics to CloudWatch
            if metrics:
                self.cloudwatch.put_metric_data(
                    Namespace=self.namespace,
                    MetricData=metrics
                )
                
        except Exception as e:
            logger.error(f"Failed to publish request metrics: {e}")
    
    async def _publish_error_metrics(self, request: Request, error: str, duration: float):
        """Publish error metrics to CloudWatch"""
        try:
            metrics = [
                {
                    'MetricName': 'RequestDuration',
                    'Value': duration,
                    'Unit': 'Milliseconds',
                    'Dimensions': [
                        {'Name': 'Endpoint', 'Value': request.url.path},
                        {'Name': 'Method', 'Value': request.method},
                        {'Name': 'StatusCode', 'Value': '500'}
                    ]
                },
                {
                    'MetricName': 'ErrorCount',
                    'Value': 1,
                    'Unit': 'Count',
                    'Dimensions': [
                        {'Name': 'Endpoint', 'Value': request.url.path},
                        {'Name': 'ErrorType', 'Value': 'UnhandledException'}
                    ]
                }
            ]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics
            )
            
        except Exception as e:
            logger.error(f"Failed to publish error metrics: {e}")


class BusinessMetricsPublisher:
    """Publisher for business-specific metrics"""
    
    def __init__(self, namespace: str = None):
        self.namespace = namespace or os.environ.get('CLOUDWATCH_NAMESPACE', 'ShopSmart/OrderProcessing')
        self.enabled = os.environ.get('CLOUDWATCH_METRICS_ENABLED', 'true').lower() == 'true'
        
        if self.enabled:
            try:
                self.cloudwatch = boto3.client('cloudwatch')
                logger.info(f"Business metrics publisher initialized for namespace: {self.namespace}")
            except Exception as e:
                logger.error(f"Failed to initialize CloudWatch client: {e}")
                self.enabled = False
    
    def publish_order_created(self, order_type: str = 'standard', value: float = None):
        """Publish order creation metrics"""
        if not self.enabled:
            return
        
        try:
            metrics = [
                {
                    'MetricName': 'OrdersCreated',
                    'Value': 1,
                    'Unit': 'Count',
                    'Dimensions': [
                        {'Name': 'OrderType', 'Value': order_type}
                    ]
                }
            ]
            
            if value is not None:
                metrics.append({
                    'MetricName': 'OrderValue',
                    'Value': value,
                    'Unit': 'None',
                    'Dimensions': [
                        {'Name': 'OrderType', 'Value': order_type}
                    ]
                })
            
            if order_type == 'luxury':
                metrics.append({
                    'MetricName': 'LuxuryOrdersProcessed',
                    'Value': 1,
                    'Unit': 'Count'
                })
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics
            )
            
        except Exception as e:
            logger.error(f"Failed to publish order creation metrics: {e}")
    
    def publish_order_processing_latency(self, duration_ms: float, order_type: str = 'standard'):
        """Publish order processing latency metrics"""
        if not self.enabled:
            return
        
        try:
            metrics = [{
                'MetricName': 'OrderProcessingLatency',
                'Value': duration_ms,
                'Unit': 'Milliseconds',
                'Dimensions': [
                    {'Name': 'OrderType', 'Value': order_type}
                ]
            }]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics
            )
            
        except Exception as e:
            logger.error(f"Failed to publish order processing latency: {e}")
    
    def publish_order_error(self, error_type: str, order_type: str = 'standard'):
        """Publish order processing error metrics"""
        if not self.enabled:
            return
        
        try:
            metrics = [{
                'MetricName': 'OrderProcessingErrors',
                'Value': 1,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'ErrorType', 'Value': error_type},
                    {'Name': 'OrderType', 'Value': order_type}
                ]
            }]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics
            )
            
        except Exception as e:
            logger.error(f"Failed to publish order error metrics: {e}")


# Global instance
business_metrics = BusinessMetricsPublisher()
