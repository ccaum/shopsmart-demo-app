"""
Enhanced metrics middleware for CloudWatch custom metrics
"""

import time
import boto3
import logging
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from config import get_settings
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

logger = logging.getLogger(__name__)

class MetricsMiddleware(BaseHTTPMiddleware):
    """Enhanced middleware for collecting and sending CloudWatch metrics"""
    
    def __init__(self, app):
        super().__init__(app)
        self.settings = get_settings()
        self.cloudwatch = None
        self.executor = ThreadPoolExecutor(max_workers=2)
        
        if self.settings.cloudwatch_enabled:
            try:
                self.cloudwatch = boto3.client('cloudwatch', region_name=self.settings.aws_region)
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
                        request.query_params
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
    
    async def _send_metrics_async(self, method: str, path: str, status_code: int, duration: float, query_params):
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
                query_params
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
    
    def _send_metrics(self, method: str, path: str, status_code: int, duration: float, query_params):
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
                    'MetricName': 'SuccessRate',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            else:
                metrics_data.append({
                    'MetricName': 'ErrorRate',
                    'Dimensions': [
                        {'Name': 'Method', 'Value': method},
                        {'Name': 'Path', 'Value': path},
                        {'Name': 'StatusCode', 'Value': str(status_code)}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            # Add search-specific metrics
            if '/products' in path and query_params.get('search'):
                metrics_data.append({
                    'MetricName': 'SearchRequests',
                    'Dimensions': [
                        {'Name': 'HasResults', 'Value': 'true' if status_code == 200 else 'false'}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
                
                metrics_data.append({
                    'MetricName': 'SearchResponseTime',
                    'Value': duration * 1000,
                    'Unit': 'Milliseconds',
                    'Timestamp': datetime.utcnow()
                })
            
            # Add pagination metrics
            if '/products' in path and query_params.get('page'):
                page_num = int(query_params.get('page', 1))
                metrics_data.append({
                    'MetricName': 'PaginationRequests',
                    'Dimensions': [
                        {'Name': 'PageRange', 'Value': self._get_page_range(page_num)}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            self.cloudwatch.put_metric_data(
                Namespace=self.settings.cloudwatch_namespace,
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
                    'MetricName': 'ErrorRate',
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
                Namespace=self.settings.cloudwatch_namespace,
                MetricData=metrics_data
            )
            
        except Exception as e:
            logger.warning(f"Failed to send error metrics: {e}")
    
    def _get_page_range(self, page_num: int) -> str:
        """Categorize page numbers for metrics"""
        if page_num == 1:
            return "first"
        elif page_num <= 5:
            return "early"
        elif page_num <= 20:
            return "middle"
        else:
            return "deep"


class CatalogMetrics:
    """Additional metrics collector for product catalog specific metrics"""
    
    def __init__(self, namespace: str = "ShopSmart/Catalog"):
        self.namespace = namespace
        self.cloudwatch = None
        
        try:
            self.cloudwatch = boto3.client('cloudwatch')
        except Exception as e:
            logger.warning(f"Failed to initialize CloudWatch client: {e}")
    
    def record_cache_hit(self, cache_type: str, hit: bool):
        """Record cache hit/miss metrics"""
        if not self.cloudwatch:
            return
        
        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'CacheHits' if hit else 'CacheMisses',
                        'Dimensions': [
                            {'Name': 'CacheType', 'Value': cache_type}
                        ],
                        'Value': 1,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'CacheHitRate',
                        'Dimensions': [
                            {'Name': 'CacheType', 'Value': cache_type}
                        ],
                        'Value': 1 if hit else 0,
                        'Unit': 'Percent',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.warning(f"Failed to send cache metrics: {e}")
    
    def record_database_query(self, query_type: str, duration: float, result_count: int = 0):
        """Record database query performance metrics"""
        if not self.cloudwatch:
            return
        
        try:
            metrics_data = [
                {
                    'MetricName': 'DatabaseQueryDuration',
                    'Dimensions': [
                        {'Name': 'QueryType', 'Value': query_type}
                    ],
                    'Value': duration * 1000,
                    'Unit': 'Milliseconds',
                    'Timestamp': datetime.utcnow()
                },
                {
                    'MetricName': 'DatabaseQueries',
                    'Dimensions': [
                        {'Name': 'QueryType', 'Value': query_type}
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                }
            ]
            
            if result_count > 0:
                metrics_data.append({
                    'MetricName': 'QueryResultCount',
                    'Dimensions': [
                        {'Name': 'QueryType', 'Value': query_type}
                    ],
                    'Value': result_count,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                })
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=metrics_data
            )
        except Exception as e:
            logger.warning(f"Failed to send database metrics: {e}")
    
    def record_connection_pool_usage(self, active_connections: int, pool_size: int):
        """Record database connection pool metrics"""
        if not self.cloudwatch:
            return
        
        try:
            utilization = (active_connections / pool_size) * 100 if pool_size > 0 else 0
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'DatabaseConnectionPoolUtilization',
                        'Value': utilization,
                        'Unit': 'Percent',
                        'Timestamp': datetime.utcnow()
                    },
                    {
                        'MetricName': 'ActiveDatabaseConnections',
                        'Value': active_connections,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.warning(f"Failed to send connection pool metrics: {e}")