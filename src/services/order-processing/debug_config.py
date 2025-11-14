#!/usr/bin/env python3
"""
Debug script to identify environment variable configuration issue
"""
import os
from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict

# Test with a simplified settings class
class TestSettings(BaseSettings):
    mongodb_url: str = Field(default="mongodb://localhost:27017/orders", env="MONGODB_URI")
    debug: bool = Field(default=False, env="DEBUG")
    
    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8"
    )

def debug_config():
    print("=== Debug Configuration ===")
    
    # Check environment variables directly
    print(f"1. Direct env check - MONGODB_URI: {os.environ.get('MONGODB_URI', 'NOT SET')}")
    print(f"   Direct env check - DEBUG: {os.environ.get('DEBUG', 'NOT SET')}")
    
    # Set environment variables
    os.environ['MONGODB_URI'] = 'mongodb://admin:Password123!@mongodb-service:27017/luxury_orders'
    os.environ['DEBUG'] = 'true'
    
    print(f"\n2. After setting - MONGODB_URI: {os.environ.get('MONGODB_URI')}")
    print(f"   After setting - DEBUG: {os.environ.get('DEBUG')}")
    
    # Test with simplified settings
    settings = TestSettings()
    print(f"\n3. TestSettings - mongodb_url: {settings.mongodb_url}")
    print(f"   TestSettings - debug: {settings.debug}")
    
    # Test with original config
    from config import Settings
    original_settings = Settings()
    print(f"\n4. Original Settings - mongodb_url: {original_settings.mongodb_url}")
    print(f"   Original Settings - debug: {original_settings.debug}")
    
    print("\n=== Debug Complete ===")

if __name__ == "__main__":
    debug_config()
