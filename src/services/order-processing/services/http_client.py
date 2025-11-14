"""
HTTP client service for cross-service communication
Handles communication with Product Catalog and Authentication services.
Enhanced with service discovery and improved retry logic.
"""

import logging
from typing import Dict, Any, Optional, List
import asyncio
import random

import httpx
from fastapi import HTTPException, status

from middleware.logging_middleware import get_correlation_id
from .service_discovery import get_service_discovery

logger = logging.getLogger(__name__)


class HTTPClientService:
    """HTTP client for communicating with external services with service discovery."""
    
    def __init__(
        self, 
        product_service_url: str = None, 
        auth_service_url: str = None,
        timeout: int = 30,
        retries: int = 3,
        use_service_discovery: bool = True
    ):
        """Initialize HTTP client service with optional service discovery."""
        # Fallback URLs (for backward compatibility)
        self.fallback_product_url = product_service_url.rstrip('/') if product_service_url else None
        self.fallback_auth_url = auth_service_url.rstrip('/') if auth_service_url else None
        
        self.timeout = timeout
        self.retries = retries
        self.use_service_discovery = use_service_discovery
        
        # Initialize service discovery
        if use_service_discovery:
            self.service_discovery = get_service_discovery()
        else:
            self.service_discovery = None
        
        # Create HTTP client with proper configuration
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=100),
            headers={
                "User-Agent": "order-processing-service/1.0.0",
                "Content-Type": "application/json"
            }
        )
    
    async def close(self) -> None:
        """Close HTTP client connections."""
        await self.client.aclose()
        logger.info(
            "HTTP client connections closed",
            extra={"correlation_id": get_correlation_id()}
        )
    
    async def _get_service_url(self, service_name: str) -> Optional[str]:
        """Get service URL using service discovery or fallback."""
        correlation_id = get_correlation_id()
        
        if self.use_service_discovery and self.service_discovery:
            try:
                url = await self.service_discovery.get_service_endpoint(service_name)
                if url:
                    return url
                logger.warning(
                    f"Service discovery failed for {service_name}, using fallback",
                    extra={"correlation_id": correlation_id}
                )
            except Exception as e:
                logger.error(
                    f"Service discovery error for {service_name}: {str(e)}",
                    extra={"correlation_id": correlation_id}
                )
        
        # Fallback to configured URLs
        if service_name == 'product-catalog':
            return self.fallback_product_url
        elif service_name == 'auth':
            return self.fallback_auth_url
        
        return None
    
    async def _get_product_service_url(self) -> str:
        """Get Product Catalog service URL."""
        url = await self._get_service_url('product-catalog')
        if not url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Product Catalog service URL not available"
            )
        return url
    
    async def _get_auth_service_url(self) -> str:
        """Get Auth service URL."""
        url = await self._get_service_url('auth')
        if not url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Auth service URL not available"
            )
        return url
    
    async def validate_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Validate user session with authentication service."""
        correlation_id = get_correlation_id()
        
        try:
            auth_service_url = await self._get_auth_service_url()
            url = f"{auth_service_url}/auth/validate/{session_id}"
            
            response = await self._make_request("GET", url)
            
            if response.status_code == 200:
                user_data = response.json()
                logger.info(
                    f"Session validated successfully: {session_id}",
                    extra={
                        "correlation_id": correlation_id,
                        "user_id": user_data.get("userId")
                    }
                )
                return user_data
            elif response.status_code == 401:
                logger.warning(
                    f"Invalid session: {session_id}",
                    extra={"correlation_id": correlation_id}
                )
                return None
            else:
                logger.error(
                    f"Session validation failed with status {response.status_code}",
                    extra={"correlation_id": correlation_id}
                )
                return None
                
        except Exception as e:
            logger.error(
                f"Session validation error: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            return None
    
    async def check_product_availability(
        self, 
        product_id: str, 
        quantity: int
    ) -> Dict[str, Any]:
        """Check product availability with product catalog service."""
        correlation_id = get_correlation_id()
        
        try:
            product_service_url = await self._get_product_service_url()
            url = f"{product_service_url}/products/{product_id}/availability"
            payload = {"quantity": quantity}
            
            response = await self._make_request("POST", url, json=payload)
            
            if response.status_code == 200:
                availability_data = response.json()
                logger.info(
                    f"Product availability checked: {product_id}",
                    extra={
                        "correlation_id": correlation_id,
                        "product_id": product_id,
                        "requested_quantity": quantity,
                        "available": availability_data.get("available", False)
                    }
                )
                return availability_data
            else:
                logger.error(
                    f"Product availability check failed: {product_id} (status: {response.status_code})",
                    extra={"correlation_id": correlation_id}
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"Unable to verify product availability for {product_id}"
                )
                
        except httpx.HTTPError as e:
            logger.error(
                f"Product availability check error: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Product catalog service unavailable"
            )
    
    async def get_product_details(self, product_id: str) -> Optional[Dict[str, Any]]:
        """Get product details from product catalog service."""
        correlation_id = get_correlation_id()
        
        try:
            product_service_url = await self._get_product_service_url()
            url = f"{product_service_url}/products/{product_id}"
            
            response = await self._make_request("GET", url)
            
            if response.status_code == 200:
                product_data = response.json()
                logger.info(
                    f"Product details retrieved: {product_id}",
                    extra={"correlation_id": correlation_id}
                )
                return product_data
            elif response.status_code == 404:
                logger.warning(
                    f"Product not found: {product_id}",
                    extra={"correlation_id": correlation_id}
                )
                return None
            else:
                logger.error(
                    f"Product details retrieval failed: {product_id} (status: {response.status_code})",
                    extra={"correlation_id": correlation_id}
                )
                return None
                
        except Exception as e:
            logger.error(
                f"Product details retrieval error: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            return None
    
    async def reserve_inventory(
        self, 
        product_id: str, 
        quantity: int,
        reservation_timeout: int = 900  # 15 minutes default
    ) -> Dict[str, Any]:
        """Reserve inventory for luxury desk orders."""
        correlation_id = get_correlation_id()
        
        try:
            product_service_url = await self._get_product_service_url()
            url = f"{product_service_url}/products/{product_id}/reserve"
            payload = {
                "quantity": quantity,
                "timeout": reservation_timeout
            }
            
            response = await self._make_request("POST", url, json=payload)
            
            if response.status_code == 200:
                reservation_data = response.json()
                logger.info(
                    f"Inventory reserved: {product_id} (qty: {quantity})",
                    extra={
                        "correlation_id": correlation_id,
                        "product_id": product_id,
                        "quantity": quantity,
                        "reservation_id": reservation_data.get("reservation_id")
                    }
                )
                return reservation_data
            else:
                logger.error(
                    f"Inventory reservation failed: {product_id} (status: {response.status_code})",
                    extra={"correlation_id": correlation_id}
                )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Unable to reserve inventory for {product_id}"
                )
                
        except httpx.HTTPError as e:
            logger.error(
                f"Inventory reservation error: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Product catalog service unavailable"
            )
    
    async def update_inventory(
        self, 
        product_id: str, 
        quantity_change: int
    ) -> bool:
        """Update product inventory after order confirmation."""
        correlation_id = get_correlation_id()
        
        try:
            product_service_url = await self._get_product_service_url()
            url = f"{product_service_url}/products/{product_id}/inventory"
            payload = {"quantity_change": quantity_change}
            
            response = await self._make_request("PUT", url, json=payload)
            
            if response.status_code == 200:
                logger.info(
                    f"Inventory updated: {product_id} (change: {quantity_change})",
                    extra={"correlation_id": correlation_id}
                )
                return True
            else:
                logger.error(
                    f"Inventory update failed: {product_id} (status: {response.status_code})",
                    extra={"correlation_id": correlation_id}
                )
                return False
                
        except Exception as e:
            logger.error(
                f"Inventory update error: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            return False
    
    async def clear_user_cart(self, user_id: str) -> bool:
        """Clear user's cart after successful order placement."""
        correlation_id = get_correlation_id()
        
        try:
            auth_service_url = await self._get_auth_service_url()
            url = f"{auth_service_url}/auth/cart/{user_id}"
            
            response = await self._make_request("DELETE", url)
            
            if response.status_code in [200, 204]:
                logger.info(
                    f"Cart cleared successfully for user: {user_id}",
                    extra={"correlation_id": correlation_id}
                )
                return True
            else:
                logger.warning(
                    f"Cart clearing failed for user: {user_id} (status: {response.status_code})",
                    extra={"correlation_id": correlation_id}
                )
                return False
                
        except Exception as e:
            logger.error(
                f"Cart clearing error for user {user_id}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            return False
    
    async def _make_request(
        self, 
        method: str, 
        url: str, 
        **kwargs
    ) -> httpx.Response:
        """Make HTTP request with enhanced retry logic and proper error handling."""
        correlation_id = get_correlation_id()
        
        # Add correlation ID to headers
        headers = kwargs.get("headers", {})
        headers["X-Correlation-ID"] = correlation_id
        kwargs["headers"] = headers
        
        last_exception = None
        
        for attempt in range(self.retries + 1):
            try:
                response = await self.client.request(method, url, **kwargs)
                
                # Log request details
                logger.debug(
                    f"HTTP {method} {url} -> {response.status_code}",
                    extra={
                        "correlation_id": correlation_id,
                        "method": method,
                        "url": url,
                        "status_code": response.status_code,
                        "attempt": attempt + 1
                    }
                )
                
                # Check for retryable HTTP status codes
                if response.status_code in [502, 503, 504] and attempt < self.retries:
                    logger.warning(
                        f"Retryable HTTP error {response.status_code} (attempt {attempt + 1}/{self.retries + 1})",
                        extra={"correlation_id": correlation_id}
                    )
                    # Treat as retryable error
                    raise httpx.HTTPStatusError(
                        f"HTTP {response.status_code}",
                        request=response.request,
                        response=response
                    )
                
                return response
                
            except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPStatusError) as e:
                last_exception = e
                if attempt < self.retries:
                    # Exponential backoff with jitter
                    base_wait = 2 ** attempt
                    jitter = random.uniform(0.1, 0.5)  # 10-50% jitter
                    wait_time = base_wait + (base_wait * jitter)
                    
                    logger.warning(
                        f"HTTP request failed (attempt {attempt + 1}/{self.retries + 1}), retrying in {wait_time:.2f}s: {str(e)}",
                        extra={
                            "correlation_id": correlation_id,
                            "error_type": type(e).__name__,
                            "wait_time": wait_time
                        }
                    )
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(
                        f"HTTP request failed after {self.retries + 1} attempts: {str(e)}",
                        extra={
                            "correlation_id": correlation_id,
                            "error_type": type(e).__name__
                        }
                    )
            
            except Exception as e:
                logger.error(
                    f"Unexpected HTTP request error: {str(e)}",
                    extra={
                        "correlation_id": correlation_id,
                        "error_type": type(e).__name__
                    }
                )
                raise
        
        # If we get here, all retries failed
        raise last_exception