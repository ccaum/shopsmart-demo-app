"""
Configuration for User Authentication Service
"""

import os
from typing import Dict, Any


class Config:
    """Base configuration class"""
    
    # Flask configuration
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
    DEBUG = os.environ.get('DEBUG', 'False').lower() == 'true'
    
    # Service configuration
    SERVICE_NAME = 'user-auth'
    SERVICE_VERSION = '1.0.0'
    PORT = int(os.environ.get('PORT', 8002))
    
    # AWS configuration
    AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
    
    # DynamoDB configuration
    USER_TABLE_NAME = os.environ.get('USER_TABLE_NAME', 'shopsmart-dev-users')
    SESSION_TABLE_NAME = os.environ.get('SESSION_TABLE_NAME', 'shopsmart-dev-sessions')
    CART_TABLE_NAME = os.environ.get('CART_TABLE_NAME', 'shopsmart-dev-carts')
    
    # Session configuration
    SESSION_TIMEOUT_HOURS = int(os.environ.get('SESSION_TIMEOUT_HOURS', 24))
    CART_TTL_DAYS = int(os.environ.get('CART_TTL_DAYS', 30))
    
    # Security configuration
    PASSWORD_MIN_LENGTH = int(os.environ.get('PASSWORD_MIN_LENGTH', 8))
    MAX_LOGIN_ATTEMPTS = int(os.environ.get('MAX_LOGIN_ATTEMPTS', 5))
    LOCKOUT_DURATION_MINUTES = int(os.environ.get('LOCKOUT_DURATION_MINUTES', 15))
    
    # CORS configuration
    CORS_ORIGINS = os.environ.get('CORS_ORIGINS', '*').split(',')
    
    # Logging configuration
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    STRUCTURED_LOGGING = os.environ.get('STRUCTURED_LOGGING', 'True').lower() == 'true'
    
    # Monitoring configuration
    DYNATRACE_ENABLED = os.environ.get('DYNATRACE_ENABLED', 'True').lower() == 'true'
    METRICS_ENABLED = os.environ.get('METRICS_ENABLED', 'True').lower() == 'true'
    
    # Rate limiting configuration
    RATE_LIMIT_ENABLED = os.environ.get('RATE_LIMIT_ENABLED', 'True').lower() == 'true'
    RATE_LIMIT_PER_MINUTE = int(os.environ.get('RATE_LIMIT_PER_MINUTE', 60))
    
    # Validation configuration
    EMAIL_VALIDATION_ENABLED = os.environ.get('EMAIL_VALIDATION_ENABLED', 'True').lower() == 'true'
    PHONE_VALIDATION_ENABLED = os.environ.get('PHONE_VALIDATION_ENABLED', 'True').lower() == 'true'
    
    @classmethod
    def get_dynamodb_config(cls) -> Dict[str, Any]:
        """Get DynamoDB configuration"""
        return {
            'region_name': cls.AWS_REGION,
            'user_table': cls.USER_TABLE_NAME,
            'session_table': cls.SESSION_TABLE_NAME,
            'cart_table': cls.CART_TABLE_NAME
        }
    
    @classmethod
    def get_security_config(cls) -> Dict[str, Any]:
        """Get security configuration"""
        return {
            'password_min_length': cls.PASSWORD_MIN_LENGTH,
            'max_login_attempts': cls.MAX_LOGIN_ATTEMPTS,
            'lockout_duration_minutes': cls.LOCKOUT_DURATION_MINUTES,
            'session_timeout_hours': cls.SESSION_TIMEOUT_HOURS
        }
    
    @classmethod
    def get_validation_config(cls) -> Dict[str, Any]:
        """Get validation configuration"""
        return {
            'email_validation_enabled': cls.EMAIL_VALIDATION_ENABLED,
            'phone_validation_enabled': cls.PHONE_VALIDATION_ENABLED
        }


class DevelopmentConfig(Config):
    """Development configuration"""
    DEBUG = True
    LOG_LEVEL = 'DEBUG'


class ProductionConfig(Config):
    """Production configuration"""
    DEBUG = False
    LOG_LEVEL = 'INFO'
    
    # Enhanced security for production
    PASSWORD_MIN_LENGTH = 12
    MAX_LOGIN_ATTEMPTS = 3
    LOCKOUT_DURATION_MINUTES = 30


class TestingConfig(Config):
    """Testing configuration"""
    TESTING = True
    DEBUG = True
    
    # Use test tables
    USER_TABLE_NAME = 'test-users'
    SESSION_TABLE_NAME = 'test-sessions'
    CART_TABLE_NAME = 'test-carts'
    
    # Disable external services
    DYNATRACE_ENABLED = False
    METRICS_ENABLED = False


# Configuration mapping
config_map = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}


def get_config(environment: str = None) -> Config:
    """Get configuration based on environment"""
    if environment is None:
        environment = os.environ.get('FLASK_ENV', 'default')
    
    return config_map.get(environment, DevelopmentConfig)