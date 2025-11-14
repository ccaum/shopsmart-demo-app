"""
Configuration management for Product Catalog Service
"""

import os
from functools import lru_cache
from pydantic import BaseSettings
import boto3
import json
import logging

logger = logging.getLogger(__name__)

class Settings(BaseSettings):
    """Application settings with environment variable support"""
    
    # Application settings
    app_name: str = "product-catalog"
    debug: bool = False
    port: int = 80
    
    # Database settings
    database_url: str = ""
    database_host: str = ""
    database_port: int = 5432
    database_name: str = "shopsmart_catalog"
    database_user: str = ""
    database_password: str = ""
    database_pool_min_size: int = 5
    database_pool_max_size: int = 20
    
    # Redis settings
    redis_host: str = ""
    redis_port: int = 6379
    redis_db: int = 0
    redis_password: str = ""
    
    # AWS settings
    aws_region: str = "us-east-1"
    secrets_manager_db_secret: str = ""
    
    # Cache settings
    cache_ttl_products: int = 900  # 15 minutes
    cache_ttl_categories: int = 300  # 5 minutes
    cache_ttl_search: int = 120  # 2 minutes
    
    # Pagination settings
    default_page_size: int = 20
    max_page_size: int = 100
    
    # CloudWatch settings
    cloudwatch_namespace: str = "ShopSmart/ProductCatalog"
    cloudwatch_enabled: bool = True
    
    # OpenTelemetry settings
    otel_service_name: str = "product-catalog-service"
    otel_service_version: str = "1.0.0"
    otel_exporter_otlp_endpoint: str = "http://localhost:4317"
    otel_exporter_otlp_headers: str = ""
    otel_exporter_otlp_insecure: bool = True
    otel_resource_attributes: str = ""
    otel_traces_sampler: str = "traceidratio"
    otel_traces_sampler_arg: float = 0.1
    
    class Config:
        env_file = ".env"
        case_sensitive = False

@lru_cache()
def get_settings() -> Settings:
    """Get cached application settings"""
    settings = Settings()
    
    # Load database credentials from AWS Secrets Manager if configured
    if settings.secrets_manager_db_secret:
        try:
            secrets_client = boto3.client('secretsmanager', region_name=settings.aws_region)
            secret_response = secrets_client.get_secret_value(
                SecretId=settings.secrets_manager_db_secret
            )
            secret_data = json.loads(secret_response['SecretString'])
            
            settings.database_user = secret_data.get('username', settings.database_user)
            settings.database_password = secret_data.get('password', settings.database_password)
            settings.database_host = secret_data.get('host', settings.database_host)
            settings.database_port = secret_data.get('port', settings.database_port)
            
            logger.info("Database credentials loaded from Secrets Manager")
        except Exception as e:
            logger.warning(f"Failed to load secrets from Secrets Manager: {e}")
    
    # Build database URL if not provided
    if not settings.database_url and settings.database_host:
        settings.database_url = (
            f"postgresql://{settings.database_user}:{settings.database_password}"
            f"@{settings.database_host}:{settings.database_port}/{settings.database_name}"
        )
    
    return settings

def get_database_config() -> dict:
    """Get database connection configuration"""
    settings = get_settings()
    return {
        "host": settings.database_host,
        "port": settings.database_port,
        "database": settings.database_name,
        "user": settings.database_user,
        "password": settings.database_password,
        "min_size": settings.database_pool_min_size,
        "max_size": settings.database_pool_max_size,
    }

def get_redis_config() -> dict:
    """Get Redis connection configuration"""
    settings = get_settings()
    return {
        "host": settings.redis_host,
        "port": settings.redis_port,
        "db": settings.redis_db,
        "password": settings.redis_password if settings.redis_password else None,
        "decode_responses": True,
    }