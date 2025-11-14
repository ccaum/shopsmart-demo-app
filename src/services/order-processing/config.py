"""
Configuration management for Order Processing Service
"""

import os
from functools import lru_cache
from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict, AliasChoices
from typing import Optional


class Settings(BaseSettings):
    """Application settings with environment variable support."""
    
    # Application settings
    app_name: str = Field(default="order-processing-service", validation_alias=AliasChoices('APP_NAME', 'app_name'))
    debug: bool = Field(default=False, validation_alias=AliasChoices('DEBUG', 'debug'))
    port: int = Field(default=8000, validation_alias=AliasChoices('PORT', 'port'))
    
    # MongoDB settings
    mongodb_url: str = Field(
        default="mongodb://localhost:27017/orders",
        validation_alias=AliasChoices('MONGODB_URI', 'mongodb_url')
    )
    mongodb_database: str = Field(default="orders", validation_alias=AliasChoices('MONGODB_DATABASE', 'mongodb_database'))
    mongodb_collection: str = Field(default="orders", validation_alias=AliasChoices('MONGODB_COLLECTION', 'mongodb_collection'))
    
    # External service URLs (fallback when service discovery is not available)
    product_service_url: str = Field(
        default="http://localhost:5000",
        validation_alias=AliasChoices('PRODUCT_SERVICE_URL', 'product_service_url')
    )
    auth_service_url: str = Field(
        default="https://api.gateway.url/auth",
        validation_alias=AliasChoices('AUTH_SERVICE_URL', 'auth_service_url')
    )
    
    # Service discovery settings
    use_service_discovery: bool = Field(default=True, validation_alias=AliasChoices('USE_SERVICE_DISCOVERY', 'use_service_discovery'))
    project_name: str = Field(default="shopsmart", validation_alias=AliasChoices('PROJECT_NAME', 'project_name'))
    deployment_environment: str = Field(default="production", validation_alias=AliasChoices('DEPLOYMENT_ENVIRONMENT', 'deployment_environment'))
    
    # HTTP client settings
    http_timeout: int = Field(default=30, validation_alias=AliasChoices('HTTP_TIMEOUT', 'http_timeout'))
    http_retries: int = Field(default=3, validation_alias=AliasChoices('HTTP_RETRIES', 'http_retries'))
    
    # Logging settings
    log_level: str = Field(default="INFO", validation_alias=AliasChoices('LOG_LEVEL', 'log_level'))
    log_format: str = Field(default="json", validation_alias=AliasChoices('LOG_FORMAT', 'log_format'))
    
    # CloudWatch settings (for container deployment)
    aws_region: str = Field(default="us-east-1", validation_alias=AliasChoices('AWS_REGION', 'aws_region'))
    cloudwatch_log_group: str = Field(
        default="/aws/ecs/order-processing",
        validation_alias=AliasChoices('CLOUDWATCH_LOG_GROUP', 'cloudwatch_log_group')
    )
    
    # Performance settings
    max_concurrent_requests: int = Field(default=100, validation_alias=AliasChoices('MAX_CONCURRENT_REQUESTS', 'max_concurrent_requests'))
    request_timeout: int = Field(default=60, validation_alias=AliasChoices('REQUEST_TIMEOUT', 'request_timeout'))
    
    # OpenTelemetry settings
    otel_service_name: str = Field(default="order-processing-service", validation_alias=AliasChoices('OTEL_SERVICE_NAME', 'otel_service_name'))
    otel_service_version: str = Field(default="1.0.0", validation_alias=AliasChoices('OTEL_SERVICE_VERSION', 'otel_service_version'))
    otel_exporter_otlp_endpoint: str = Field(default="http://localhost:4317", validation_alias=AliasChoices('OTEL_EXPORTER_OTLP_ENDPOINT', 'otel_exporter_otlp_endpoint'))
    otel_exporter_otlp_headers: str = Field(default="", validation_alias=AliasChoices('OTEL_EXPORTER_OTLP_HEADERS', 'otel_exporter_otlp_headers'))
    otel_exporter_otlp_insecure: bool = Field(default=True, validation_alias=AliasChoices('OTEL_EXPORTER_OTLP_INSECURE', 'otel_exporter_otlp_insecure'))
    otel_resource_attributes: str = Field(default="", validation_alias=AliasChoices('OTEL_RESOURCE_ATTRIBUTES', 'otel_resource_attributes'))
    otel_traces_sampler: str = Field(default="traceidratio", validation_alias=AliasChoices('OTEL_TRACES_SAMPLER', 'otel_traces_sampler'))
    otel_traces_sampler_arg: float = Field(default=0.1, validation_alias=AliasChoices('OTEL_TRACES_SAMPLER_ARG', 'otel_traces_sampler_arg'))
    
    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8"
    )


@lru_cache()
def get_settings() -> Settings:
    """Get cached application settings."""
    return Settings()