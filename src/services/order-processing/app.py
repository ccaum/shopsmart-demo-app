"""
Order Processing Service - FastAPI Application
Handles order creation, management, and history for the shopping cart demo.
"""

import os
import uuid
import logging
from datetime import datetime, timedelta
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import motor.motor_asyncio
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError
import httpx

# OpenTelemetry imports
from opentelemetry import trace, metrics
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.pymongo import PymongoInstrumentor
from opentelemetry.sdk.resources import Resource
import logging as stdlib_logging

# Configure OpenTelemetry
def configure_opentelemetry():
    """Configure OpenTelemetry with standard environment variables"""
    
    # Get configuration from environment variables (set by Kubernetes)
    otel_endpoint = os.getenv('OTEL_EXPORTER_OTLP_ENDPOINT')
    service_name = os.getenv('OTEL_SERVICE_NAME', 'order-processing-service')
    
    if not otel_endpoint:
        stdlib_logging.warning("OTEL_EXPORTER_OTLP_ENDPOINT not set - telemetry disabled")
        return trace.get_tracer(__name__), metrics.get_meter(__name__)
    
    # Create resource with service information from environment
    resource_attributes = {
        'service.name': service_name,
        'service.instance.id': os.getenv('HOSTNAME', 'unknown')
    }
    
    if os.getenv('OTEL_RESOURCE_ATTRIBUTES'):
        for attr in os.getenv('OTEL_RESOURCE_ATTRIBUTES').split(','):
            if '=' in attr:
                key, value = attr.split('=', 1)
                resource_attributes[key.strip()] = value.strip()
    
    resource = Resource.create(resource_attributes)
    
    # Configure tracer provider
    trace.set_tracer_provider(TracerProvider(resource=resource))
    tracer_provider = trace.get_tracer_provider()
    
    # Configure OTLP trace exporter to collector using HTTP
    # Create sessions with Connection: close to prevent connection pooling issues
    import requests
    from requests.adapters import HTTPAdapter
    
    trace_session = requests.Session()
    trace_session.headers.update({"Connection": "close"})
    trace_session.mount('http://', HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=0))
    
    stdlib_logging.info(f"Configuring OTLP trace exporter (HTTP): {otel_endpoint}/v1/traces")
    otlp_trace_exporter = OTLPSpanExporter(
        endpoint=f"{otel_endpoint}/v1/traces",
        timeout=10,
        session=trace_session
    )
    
    # Add span processor
    span_processor = BatchSpanProcessor(otlp_trace_exporter)
    tracer_provider.add_span_processor(span_processor)
    stdlib_logging.info("Trace exporter configured successfully")
    
    # Configure meter provider
    metric_session = requests.Session()
    metric_session.headers.update({"Connection": "close"})
    metric_session.mount('http://', HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=0))
    
    stdlib_logging.info(f"Configuring OTLP metric exporter (HTTP): {otel_endpoint}/v1/metrics")
    otlp_metric_exporter = OTLPMetricExporter(
        endpoint=f"{otel_endpoint}/v1/metrics",
        timeout=10,
        session=metric_session
    )
    
    metric_reader = PeriodicExportingMetricReader(otlp_metric_exporter)
    metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))
    stdlib_logging.info("Metric exporter configured successfully")
    
    # Configure logger provider
    log_session = requests.Session()
    log_session.headers.update({"Connection": "close"})
    log_session.mount('http://', HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=0))
    
    stdlib_logging.info(f"Configuring OTLP log exporter (HTTP): {otel_endpoint}/v1/logs")
    logger_provider = LoggerProvider(resource=resource)
    otlp_log_exporter = OTLPLogExporter(
        endpoint=f"{otel_endpoint}/v1/logs",
        timeout=10,
        session=log_session
    )
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(otlp_log_exporter))
    
    # Attach OTEL handler to root logger
    handler = LoggingHandler(level=stdlib_logging.INFO, logger_provider=logger_provider)
    stdlib_logging.getLogger().addHandler(handler)
    
    stdlib_logging.info(f"OpenTelemetry configured: endpoint={otel_endpoint}, service={service_name}")
    
    return trace.get_tracer(__name__), metrics.get_meter(__name__)

from config import get_settings
from models import (
    Order, OrderItem, OrderStatus, CreateOrderRequest, OrderResponse, 
    OrderStatusUpdate, OrderListResponse, LuxuryOrderCreate, 
    OrderStatusUpdateRequest, TrackingInfo
)
from services.mongodb_service import MongoDBService
from services.http_client import HTTPClientService
from services.service_discovery import get_service_discovery
from middleware.logging_middleware import setup_logging, get_correlation_id, correlation_id_middleware
from middleware.metrics_middleware import OrderMetricsMiddleware

# Setup structured logging early
logger = setup_logging()

# Initialize OpenTelemetry
tracer, meter = configure_opentelemetry()

# Global services
mongodb_service: Optional[MongoDBService] = None
http_client: Optional[HTTPClientService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager for startup and shutdown events."""
    global mongodb_service, http_client
    
    settings = get_settings()
    
    try:
        # Initialize MongoDB service
        mongodb_service = MongoDBService(settings.mongodb_url)
        await mongodb_service.connect()
        logger.info("MongoDB connection established")
        
        # Initialize HTTP client service with service discovery
        http_client = HTTPClientService(
            product_service_url=settings.product_service_url,
            auth_service_url=settings.auth_service_url,
            timeout=settings.http_timeout,
            retries=settings.http_retries,
            use_service_discovery=settings.use_service_discovery
        )
        logger.info("HTTP client service initialized")
        
        yield
        
    except Exception as e:
        logger.error(f"Failed to initialize services: {str(e)}")
        raise
    finally:
        # Cleanup
        if mongodb_service:
            await mongodb_service.disconnect()
            logger.info("MongoDB connection closed")
        if http_client:
            await http_client.close()
            logger.info("HTTP client closed")


# Create FastAPI application
app = FastAPI(
    title="Order Processing Service",
    description="Handles order creation, management, and history for the shopping cart demo",
    version="1.0.0",
    lifespan=lifespan
)

# Auto-instrument FastAPI and related libraries
FastAPIInstrumentor.instrument_app(app)
HTTPXClientInstrumentor().instrument()
PymongoInstrumentor().instrument()

# Add X-Ray middleware if enabled
xray_enabled = os.environ.get('ENABLE_XRAY', 'false').lower() == 'true'
if xray_enabled:
    from aws_xray_sdk.core import xray_recorder
    
    @app.middleware("http")
    async def xray_middleware(request, call_next):
        with xray_recorder.in_subsegment('order-processing-request'):
            response = await call_next(request)
            return response

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add metrics middleware
from middleware.cloudwatch_middleware import CloudWatchMetricsMiddleware, business_metrics
app.add_middleware(CloudWatchMetricsMiddleware)

# Add correlation ID middleware
app.middleware("http")(correlation_id_middleware)
app.add_middleware(OrderMetricsMiddleware)


def get_mongodb_service() -> MongoDBService:
    """Dependency to get MongoDB service instance."""
    if mongodb_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database service unavailable"
        )
    return mongodb_service


def get_http_client() -> HTTPClientService:
    """Dependency to get HTTP client service instance."""
    if http_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HTTP client service unavailable"
        )
    return http_client


@app.get("/config/opentelemetry")
async def get_opentelemetry_config():
    """Get OpenTelemetry configuration for frontend."""
    try:
        import boto3
        ssm_client = boto3.client('ssm')
        
        # Get configuration from SSM parameters
        endpoint_param = os.getenv('OTEL_EXPORTER_OTLP_ENDPOINT_PARAM')
        token_param = os.getenv('OTEL_EXPORTER_OTLP_TOKEN_PARAM')
        environment = os.getenv('DEPLOYMENT_ENVIRONMENT', 'production')
        
        config = {
            'endpoint': '',
            'apiToken': '',
            'environment': environment
        }
        
        if endpoint_param and token_param:
            try:
                # Get endpoint from SSM
                endpoint_response = ssm_client.get_parameter(Name=endpoint_param)
                config['endpoint'] = endpoint_response['Parameter']['Value']
                
                # Get API token from SSM
                token_response = ssm_client.get_parameter(Name=token_param)
                config['apiToken'] = token_response['Parameter']['Value']
                
            except Exception as e:
                logger.warning(f"Failed to retrieve OpenTelemetry config from SSM: {e}")
                # Return empty config on error
                pass
        
        return config
        
    except Exception as e:
        logger.error(f"Error in OpenTelemetry config endpoint: {e}")
        return {
            'endpoint': '',
            'apiToken': '',
            'environment': 'production'
        }


@app.get("/test-trace")
async def test_trace():
    """Test endpoint to verify tracing is working."""
    with tracer.start_as_current_span("test_trace_span") as span:
        span.set_attribute("test.attribute", "test_value")
        logger.info("Test trace span created")
        
        # Force flush
        from opentelemetry import trace as trace_api
        tracer_provider = trace_api.get_tracer_provider()
        if hasattr(tracer_provider, 'force_flush'):
            result = tracer_provider.force_flush()
            logger.info(f"Force flush result: {result}")
        
        return {"status": "trace_created", "span_id": format(span.get_span_context().span_id, '016x')}


@app.get("/health")
async def health_check():
    """Health check endpoint with comprehensive dependency verification."""
    correlation_id = get_correlation_id()
    
    health_status = {
        'status': 'healthy',
        'service': 'order-processing',
        'version': '1.0.0',
        'timestamp': datetime.utcnow().isoformat(),
        'dependencies': {}
    }
    
    try:
        # Check MongoDB connection
        if mongodb_service:
            try:
                await mongodb_service.health_check()
                health_status['dependencies']['mongodb'] = 'connected'
            except Exception as e:
                logger.error(f"MongoDB health check failed: {str(e)}", extra={"correlation_id": correlation_id})
                health_status['status'] = 'unhealthy'
                health_status['dependencies']['mongodb'] = f'error: {str(e)}'
                health_status['error'] = 'MongoDB connectivity failed'
        else:
            health_status['status'] = 'unhealthy'
            health_status['dependencies']['mongodb'] = 'not_initialized'
            health_status['error'] = 'MongoDB service not initialized'
        
        # Check HTTP client service
        if http_client:
            health_status['dependencies']['http_client'] = 'ready'
        else:
            health_status['status'] = 'degraded' if health_status['status'] == 'healthy' else health_status['status']
            health_status['dependencies']['http_client'] = 'not_initialized'
            health_status['warning'] = 'HTTP client service not initialized'
        
        # Check service discovery and external service connectivity
        try:
            settings = get_settings()
            
            # Check service discovery
            if settings.use_service_discovery:
                try:
                    service_discovery = get_service_discovery()
                    discovered_services = await service_discovery.get_all_services()
                    health_status['dependencies']['service_discovery'] = {
                        'status': 'enabled',
                        'discovered_services': list(discovered_services.keys())
                    }
                    
                    # Try to get service URLs via discovery
                    product_url = await service_discovery.get_service_endpoint('product-catalog')
                    auth_url = await service_discovery.get_service_endpoint('auth')
                    
                    if product_url:
                        health_status['dependencies']['product_service'] = 'discovered'
                    elif settings.product_service_url:
                        health_status['dependencies']['product_service'] = 'fallback_configured'
                    else:
                        health_status['dependencies']['product_service'] = 'not_available'
                    
                    if auth_url:
                        health_status['dependencies']['auth_service'] = 'discovered'
                    elif settings.auth_service_url:
                        health_status['dependencies']['auth_service'] = 'fallback_configured'
                    else:
                        health_status['dependencies']['auth_service'] = 'not_available'
                        
                except Exception as sd_error:
                    logger.warning(f"Service discovery check failed: {str(sd_error)}", extra={"correlation_id": correlation_id})
                    health_status['dependencies']['service_discovery'] = {
                        'status': 'error',
                        'error': str(sd_error)
                    }
                    # Fall back to static configuration check
                    if settings.product_service_url:
                        health_status['dependencies']['product_service'] = 'fallback_configured'
                    if settings.auth_service_url:
                        health_status['dependencies']['auth_service'] = 'fallback_configured'
            else:
                health_status['dependencies']['service_discovery'] = {'status': 'disabled'}
                if settings.product_service_url:
                    health_status['dependencies']['product_service'] = 'configured'
                if settings.auth_service_url:
                    health_status['dependencies']['auth_service'] = 'configured'
                    
        except Exception as e:
            logger.warning(f"External service configuration check failed: {str(e)}", extra={"correlation_id": correlation_id})
            health_status['dependencies']['external_services'] = f'config_error: {str(e)}'
        
        # Check environment configuration
        try:
            settings = get_settings()
            health_status['dependencies']['environment'] = 'configured'
        except Exception as e:
            health_status['status'] = 'degraded' if health_status['status'] == 'healthy' else health_status['status']
            health_status['dependencies']['environment'] = f'error: {str(e)}'
            if 'warning' not in health_status:
                health_status['warning'] = 'Environment configuration issues detected'
        
        logger.info(f"Health check completed with status: {health_status['status']}", extra={"correlation_id": correlation_id})
        
        # Return appropriate status code
        if health_status['status'] == 'healthy':
            return health_status
        else:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=health_status
            )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in health check: {str(e)}", extra={"correlation_id": correlation_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                'status': 'unhealthy',
                'service': 'order-processing',
                'timestamp': datetime.utcnow().isoformat(),
                'error': str(e),
                'dependencies': {}
            }
        )


@app.get("/health/ready")
async def readiness_check():
    """Readiness check endpoint for Kubernetes/ECS deployment."""
    correlation_id = get_correlation_id()
    
    readiness_status = {
        'status': 'ready',
        'service': 'order-processing',
        'timestamp': datetime.utcnow().isoformat(),
        'dependencies': {}
    }
    
    try:
        # Check MongoDB connection
        if mongodb_service:
            try:
                await mongodb_service.health_check()
                readiness_status['dependencies']['mongodb'] = 'connected'
            except Exception as e:
                logger.error(f"MongoDB readiness check failed: {str(e)}", extra={"correlation_id": correlation_id})
                readiness_status['status'] = 'not_ready'
                readiness_status['dependencies']['mongodb'] = f'error: {str(e)}'
                readiness_status['error'] = 'MongoDB not ready'
        else:
            readiness_status['status'] = 'not_ready'
            readiness_status['dependencies']['mongodb'] = 'not_initialized'
            readiness_status['error'] = 'MongoDB service not initialized'
        
        # Check HTTP client service
        if http_client:
            readiness_status['dependencies']['http_client'] = 'ready'
        else:
            readiness_status['status'] = 'not_ready'
            readiness_status['dependencies']['http_client'] = 'not_initialized'
            readiness_status['error'] = 'HTTP client service not initialized'
        
        # Test external service connectivity for readiness
        try:
            settings = get_settings()
            if settings.product_service_url and settings.auth_service_url:
                readiness_status['dependencies']['external_services'] = 'configured'
            else:
                readiness_status['status'] = 'not_ready'
                readiness_status['dependencies']['external_services'] = 'not_configured'
                readiness_status['error'] = 'External service URLs not configured'
        except Exception as e:
            logger.error(f"External service readiness check failed: {str(e)}", extra={"correlation_id": correlation_id})
            readiness_status['status'] = 'not_ready'
            readiness_status['dependencies']['external_services'] = f'error: {str(e)}'
            readiness_status['error'] = 'External service configuration failed'
        
        logger.info(f"Readiness check completed with status: {readiness_status['status']}", extra={"correlation_id": correlation_id})
        
        # Return appropriate status code
        if readiness_status['status'] == 'ready':
            return readiness_status
        else:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=readiness_status
            )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in readiness check: {str(e)}", extra={"correlation_id": correlation_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not ready"
        )


@app.post("/orders", response_model=OrderResponse, status_code=status.HTTP_201_CREATED)
async def create_luxury_order(
    order_request: LuxuryOrderCreate,
    mongodb_service: MongoDBService = Depends(get_mongodb_service),
    http_client: HTTPClientService = Depends(get_http_client)
):
    """Create a new luxury desk order with enhanced validation and delivery estimation."""
    correlation_id = get_correlation_id()
    
    with tracer.start_as_current_span("create_luxury_order") as span:
        span.set_attribute("user.id", order_request.user_id)
        span.set_attribute("order.item_count", len(order_request.items))
        span.set_attribute("correlation.id", correlation_id)
        
        logger.info(
            f"Creating luxury order for user: {order_request.user_id}",
            extra={
                "correlation_id": correlation_id,
                "user_id": order_request.user_id,
                "item_count": len(order_request.items)
            }
        )
    
    try:
        # Process items directly without validation
        validated_items = []
        total_amount = 0.0
        max_crafting_time = 0
        
        for item in order_request.items:
            validated_item = OrderItem(
                productId=item.product_id,
                name=item.name,
                price=item.price,
                quantity=item.quantity,
                craftingTimeMonths=item.crafting_time_months,
                artisanName=item.artisan_name,
                material=item.material,
                style=item.style,
                customizations=item.customizations or {}
            )
            validated_items.append(validated_item)
            total_amount += validated_item.price * validated_item.quantity
            
            if validated_item.crafting_time_months:
                max_crafting_time = max(max_crafting_time, validated_item.crafting_time_months)
        
        # Calculate estimated delivery date based on crafting time
        estimated_delivery = None
        if max_crafting_time > 0:
            from datetime import timedelta
            # Add crafting time plus 2 weeks for shipping
            estimated_delivery = datetime.utcnow() + timedelta(days=(max_crafting_time * 30) + 14)
        
        # Create luxury order object
        order_id = str(uuid.uuid4())
        order = Order(
            orderId=order_id,
            userId=order_request.user_id,
            items=validated_items,
            totalAmount=round(total_amount, 2),
            shippingAddress=order_request.shipping_address,
            status=OrderStatus.PENDING,
            estimatedDelivery=estimated_delivery,
            trackingInfo={}
        )
        
        # Save order to database
        await mongodb_service.create_order(order)
        
        logger.info(
            f"Luxury order created successfully: {order_id}",
            extra={
                "correlation_id": correlation_id,
                "order_id": order_id,
                "total_amount": total_amount,
                "estimated_delivery": estimated_delivery.isoformat() if estimated_delivery else None,
                "max_crafting_time_months": max_crafting_time
            }
        )
        
        # Convert to response model
        return OrderResponse(
            orderId=order.order_id,
            userId=order.user_id,
            items=order.items,
            totalAmount=order.total_amount,
            shippingAddress=order.shipping_address,
            status=order.status,
            estimatedDelivery=order.estimated_delivery,
            craftingStartDate=order.crafting_start_date,
            trackingInfo=order.tracking_info,
            createdAt=order.created_at,
            updatedAt=order.updated_at
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Luxury order creation failed: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create luxury order"
        )


@app.get("/orders/user/{user_id}", response_model=OrderListResponse)
async def get_user_orders(
    user_id: str,
    page: int = 1,
    page_size: int = 10,
    status_filter: Optional[OrderStatus] = None,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Get order history for a specific user with pagination and optional status filtering."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Retrieving orders for user: {user_id}",
        extra={
            "correlation_id": correlation_id,
            "user_id": user_id,
            "page": page,
            "page_size": page_size,
            "status_filter": status_filter.value if status_filter else None
        }
    )
    
    try:
        # Validate pagination parameters
        if page < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Page number must be greater than 0"
            )
        
        if page_size < 1 or page_size > 100:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Page size must be between 1 and 100"
            )
        
        # Get user orders (with optional status filtering)
        if status_filter:
            # For now, use the existing method and filter in memory
            # In production, you'd want to add a filtered query method
            orders_response = await mongodb_service.get_user_orders(user_id, page, page_size)
            # Filter orders by status
            filtered_orders = [order for order in orders_response.orders if order.status == status_filter]
            orders_response.orders = filtered_orders
        else:
            orders_response = await mongodb_service.get_user_orders(user_id, page, page_size)
        
        logger.info(
            f"Retrieved {len(orders_response.orders)} orders for user: {user_id}",
            extra={"correlation_id": correlation_id}
        )
        
        return orders_response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to retrieve orders for user {user_id}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve orders"
        )


@app.get("/orders/{order_id}", response_model=OrderResponse)
async def get_order_details(
    order_id: str,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Get detailed information and tracking status for a specific luxury order."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Retrieving luxury order details: {order_id}",
        extra={"correlation_id": correlation_id}
    )
    
    try:
        order = await mongodb_service.get_order_by_id(order_id)
        
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order {order_id} not found"
            )
        
        logger.info(
            f"Luxury order details retrieved: {order_id}",
            extra={
                "correlation_id": correlation_id,
                "order_status": order.status,
                "has_tracking": bool(order.tracking_info)
            }
        )
        
        return order
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to retrieve luxury order details {order_id}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve order details"
        )


@app.post("/orders/{order_id}/confirm", response_model=OrderResponse)
async def confirm_order(
    order_id: str,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Confirm a pending luxury order and move it to confirmed status."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Confirming luxury order: {order_id}",
        extra={"correlation_id": correlation_id, "order_id": order_id}
    )
    
    try:
        # Get current order to validate it's in pending status
        order = await mongodb_service.get_order_by_id(order_id)
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order {order_id} not found"
            )
        
        if order.status != OrderStatus.PENDING:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Order {order_id} cannot be confirmed. Current status: {order.status}"
            )
        
        # Update order to confirmed status
        success = await mongodb_service.update_luxury_order(
            order_id=order_id,
            status=OrderStatus.CONFIRMED,
            notes="Order confirmed and ready for crafting"
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to confirm order"
            )
        
        # Get updated order
        updated_order = await mongodb_service.get_order_by_id(order_id)
        
        logger.info(
            f"Order confirmed successfully: {order_id}",
            extra={"correlation_id": correlation_id}
        )
        
        return updated_order
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to confirm order {order_id}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to confirm order"
        )


@app.put("/orders/{order_id}/status", response_model=OrderResponse)
async def update_luxury_order_status(
    order_id: str,
    status_update: OrderStatusUpdateRequest,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Update the status of a luxury order with enhanced tracking (admin endpoint)."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Updating luxury order status: {order_id} -> {status_update.status}",
        extra={
            "correlation_id": correlation_id,
            "order_id": order_id,
            "new_status": status_update.status
        }
    )
    
    try:
        # Prepare tracking info if provided
        tracking_info_dict = None
        if status_update.tracking_info:
            tracking_info_dict = status_update.tracking_info.dict(by_alias=True, exclude_none=True)
        
        success = await mongodb_service.update_luxury_order(
            order_id=order_id,
            status=status_update.status,
            crafting_start_date=status_update.crafting_start_date,
            estimated_delivery=status_update.estimated_delivery,
            tracking_info=tracking_info_dict,
            notes=status_update.notes
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order {order_id} not found"
            )
        
        # Get updated order
        updated_order = await mongodb_service.get_order_by_id(order_id)
        
        logger.info(
            f"Luxury order status updated successfully: {order_id}",
            extra={"correlation_id": correlation_id}
        )
        
        return updated_order
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to update luxury order status {order_id}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update luxury order status"
        )


@app.get("/orders/status/{status_value}", response_model=OrderListResponse)
async def get_orders_by_status(
    status_value: OrderStatus,
    page: int = 1,
    page_size: int = 10,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Get orders filtered by status (admin endpoint)."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Retrieving orders by status: {status_value}",
        extra={
            "correlation_id": correlation_id,
            "status": status_value,
            "page": page,
            "page_size": page_size
        }
    )
    
    try:
        # Validate pagination parameters
        if page < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Page number must be greater than 0"
            )
        
        if page_size < 1 or page_size > 100:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Page size must be between 1 and 100"
            )
        
        # Get orders by status
        orders_response = await mongodb_service.get_orders_by_status(status_value, page, page_size)
        
        logger.info(
            f"Retrieved {len(orders_response.orders)} orders with status {status_value}",
            extra={"correlation_id": correlation_id}
        )
        
        return orders_response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to retrieve orders by status {status_value}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve orders by status"
        )


@app.get("/orders/{order_id}/tracking", response_model=dict)
async def get_order_tracking(
    order_id: str,
    mongodb_service: MongoDBService = Depends(get_mongodb_service)
):
    """Get detailed tracking information for a specific order."""
    correlation_id = get_correlation_id()
    
    logger.info(
        f"Retrieving tracking info for order: {order_id}",
        extra={"correlation_id": correlation_id}
    )
    
    try:
        order = await mongodb_service.get_order_by_id(order_id)
        
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order {order_id} not found"
            )
        
        # Calculate progress percentage based on status
        status_progress = {
            OrderStatus.PENDING: 10,
            OrderStatus.CONFIRMED: 25,
            OrderStatus.CRAFTING: 60,
            OrderStatus.SHIPPING: 85,
            OrderStatus.DELIVERED: 100,
            OrderStatus.CANCELLED: 0
        }
        
        # Prepare tracking response
        tracking_response = {
            "order_id": order.order_id,
            "status": order.status,
            "progress_percentage": status_progress.get(order.status, 0),
            "created_at": order.created_at.isoformat(),
            "updated_at": order.updated_at.isoformat(),
            "estimated_delivery": order.estimated_delivery.isoformat() if order.estimated_delivery else None,
            "crafting_start_date": order.crafting_start_date.isoformat() if order.crafting_start_date else None,
            "tracking_info": order.tracking_info or {},
            "timeline": []
        }
        
        # Build status timeline
        timeline = [
            {
                "status": "Order Placed",
                "date": order.created_at.isoformat(),
                "completed": True,
                "description": "Your luxury desk order has been received"
            }
        ]
        
        if order.status in [OrderStatus.CONFIRMED, OrderStatus.CRAFTING, OrderStatus.SHIPPING, OrderStatus.DELIVERED]:
            timeline.append({
                "status": "Order Confirmed",
                "date": order.updated_at.isoformat(),
                "completed": True,
                "description": "Order confirmed and materials sourced"
            })
        
        if order.status in [OrderStatus.CRAFTING, OrderStatus.SHIPPING, OrderStatus.DELIVERED]:
            timeline.append({
                "status": "Crafting Started",
                "date": order.crafting_start_date.isoformat() if order.crafting_start_date else order.updated_at.isoformat(),
                "completed": True,
                "description": "Artisan has begun crafting your desk"
            })
        
        if order.status in [OrderStatus.SHIPPING, OrderStatus.DELIVERED]:
            timeline.append({
                "status": "Shipped",
                "date": order.updated_at.isoformat(),
                "completed": True,
                "description": "Your desk is on its way"
            })
        
        if order.status == OrderStatus.DELIVERED:
            timeline.append({
                "status": "Delivered",
                "date": order.updated_at.isoformat(),
                "completed": True,
                "description": "Your luxury desk has been delivered"
            })
        
        tracking_response["timeline"] = timeline
        
        logger.info(
            f"Tracking info retrieved for order: {order_id}",
            extra={"correlation_id": correlation_id}
        )
        
        return tracking_response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to retrieve tracking info for order {order_id}: {str(e)}",
            extra={"correlation_id": correlation_id}
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve tracking information"
        )


if __name__ == "__main__":
    import uvicorn
    
    settings = get_settings()
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=settings.port,
        log_level="info",
        reload=settings.debug
    )
