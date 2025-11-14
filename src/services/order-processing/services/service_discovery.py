"""
Service Discovery module for Order Processing Service
Handles dynamic discovery of service endpoints using AWS SSM Parameter Store.
"""

import logging
import os
from typing import Dict, Optional, Any
from functools import lru_cache
import asyncio
import json

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

from middleware.logging_middleware import get_correlation_id

logger = logging.getLogger(__name__)


class ServiceDiscovery:
    """Service discovery client for finding and caching service endpoints."""
    
    def __init__(self, project_name: str, environment: str, region: str = "us-east-1"):
        """Initialize service discovery client."""
        self.project_name = project_name
        self.environment = environment
        self.region = region
        self.ssm_prefix = f"/{project_name}/{environment}/services"
        
        # Cache for service endpoints
        self._service_cache: Dict[str, Dict[str, Any]] = {}
        self._cache_ttl = 300  # 5 minutes cache TTL
        self._last_cache_update = 0
        
        # Initialize SSM client
        try:
            self.ssm_client = boto3.client('ssm', region_name=region)
            self._ssm_available = True
            logger.info(
                f"Service discovery initialized for {project_name}-{environment}",
                extra={"correlation_id": get_correlation_id()}
            )
        except (NoCredentialsError, Exception) as e:
            logger.warning(
                f"SSM client initialization failed: {str(e)}. Falling back to environment variables.",
                extra={"correlation_id": get_correlation_id()}
            )
            self.ssm_client = None
            self._ssm_available = False
    
    async def get_service_endpoint(self, service_name: str) -> Optional[str]:
        """Get service endpoint URL for the specified service."""
        correlation_id = get_correlation_id()
        
        try:
            # Try to get from cache first
            if self._is_cache_valid() and service_name in self._service_cache:
                endpoint = self._service_cache[service_name].get('full_url')
                if endpoint:
                    logger.debug(
                        f"Service endpoint retrieved from cache: {service_name} -> {endpoint}",
                        extra={"correlation_id": correlation_id}
                    )
                    return endpoint
            
            # Refresh cache if needed
            await self._refresh_service_cache()
            
            # Get from refreshed cache
            if service_name in self._service_cache:
                endpoint = self._service_cache[service_name].get('full_url')
                if endpoint:
                    logger.info(
                        f"Service endpoint discovered: {service_name} -> {endpoint}",
                        extra={"correlation_id": correlation_id}
                    )
                    return endpoint
            
            # Fallback to environment variables
            endpoint = self._get_fallback_endpoint(service_name)
            if endpoint:
                logger.info(
                    f"Service endpoint from fallback: {service_name} -> {endpoint}",
                    extra={"correlation_id": correlation_id}
                )
                return endpoint
            
            logger.warning(
                f"Service endpoint not found: {service_name}",
                extra={"correlation_id": correlation_id}
            )
            return None
            
        except Exception as e:
            logger.error(
                f"Error getting service endpoint for {service_name}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            # Try fallback
            return self._get_fallback_endpoint(service_name)
    
    async def get_service_health_endpoint(self, service_name: str) -> Optional[str]:
        """Get health check endpoint for the specified service."""
        correlation_id = get_correlation_id()
        
        try:
            # Ensure cache is fresh
            if not self._is_cache_valid():
                await self._refresh_service_cache()
            
            if service_name in self._service_cache:
                service_info = self._service_cache[service_name]
                base_url = service_info.get('full_url')
                health_path = service_info.get('health_endpoint', '/health')
                
                if base_url:
                    if health_path.startswith('http'):
                        # Absolute URL
                        health_url = health_path
                    else:
                        # Relative path
                        health_url = f"{base_url.rstrip('/')}{health_path}"
                    
                    logger.debug(
                        f"Service health endpoint: {service_name} -> {health_url}",
                        extra={"correlation_id": correlation_id}
                    )
                    return health_url
            
            # Fallback
            base_endpoint = self._get_fallback_endpoint(service_name)
            if base_endpoint:
                health_url = f"{base_endpoint.rstrip('/')}/health"
                logger.info(
                    f"Service health endpoint from fallback: {service_name} -> {health_url}",
                    extra={"correlation_id": correlation_id}
                )
                return health_url
            
            return None
            
        except Exception as e:
            logger.error(
                f"Error getting health endpoint for {service_name}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            return None
    
    async def get_all_services(self) -> Dict[str, Dict[str, Any]]:
        """Get all discovered services and their information."""
        if not self._is_cache_valid():
            await self._refresh_service_cache()
        
        return self._service_cache.copy()
    
    async def _refresh_service_cache(self) -> None:
        """Refresh the service cache from SSM Parameter Store."""
        correlation_id = get_correlation_id()
        
        if not self._ssm_available:
            logger.debug(
                "SSM not available, skipping cache refresh",
                extra={"correlation_id": correlation_id}
            )
            return
        
        try:
            # Get all service parameters
            response = self.ssm_client.get_parameters_by_path(
                Path=self.ssm_prefix,
                Recursive=True,
                MaxResults=10  # AWS SSM limit
            )
            
            # Parse parameters into service cache
            services = {}
            for param in response['Parameters']:
                # Parse parameter name: /project/env/services/service-name/property
                param_path = param['Name'].replace(self.ssm_prefix, '').strip('/')
                path_parts = param_path.split('/')
                
                if len(path_parts) >= 2:
                    service_name = path_parts[0]
                    property_name = path_parts[1]
                    
                    if service_name not in services:
                        services[service_name] = {}
                    
                    services[service_name][property_name] = param['Value']
            
            # Update cache
            self._service_cache = services
            self._last_cache_update = asyncio.get_event_loop().time()
            
            logger.info(
                f"Service cache refreshed with {len(services)} services",
                extra={
                    "correlation_id": correlation_id,
                    "services": list(services.keys())
                }
            )
            
        except ClientError as e:
            logger.error(
                f"Failed to refresh service cache from SSM: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
        except Exception as e:
            logger.error(
                f"Unexpected error refreshing service cache: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
    
    def _is_cache_valid(self) -> bool:
        """Check if the service cache is still valid."""
        if not self._service_cache:
            return False
        
        current_time = asyncio.get_event_loop().time()
        return (current_time - self._last_cache_update) < self._cache_ttl
    
    def _get_fallback_endpoint(self, service_name: str) -> Optional[str]:
        """Get service endpoint from environment variables as fallback."""
        # Map service names to environment variable names
        env_var_map = {
            'auth': 'AUTH_SERVICE_URL',
            'product-catalog': 'PRODUCT_SERVICE_URL',
            'order-processing': 'ORDER_PROCESSING_SERVICE_URL'
        }
        
        env_var = env_var_map.get(service_name)
        if env_var:
            return os.environ.get(env_var)
        
        # Try generic pattern
        generic_env_var = f"{service_name.upper().replace('-', '_')}_SERVICE_URL"
        return os.environ.get(generic_env_var)


@lru_cache()
def get_service_discovery() -> ServiceDiscovery:
    """Get cached service discovery instance."""
    project_name = os.environ.get('PROJECT_NAME', 'shopsmart')
    environment = os.environ.get('DEPLOYMENT_ENVIRONMENT', 'production')
    region = os.environ.get('AWS_REGION', 'us-east-1')
    
    return ServiceDiscovery(project_name, environment, region)