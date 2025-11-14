"""
Database connection management for Product Catalog Service
"""

import asyncpg
import redis.asyncio as redis
import logging
from typing import Optional
from config import get_database_config, get_redis_config

logger = logging.getLogger(__name__)

# Global connection pool instances
_db_pool: Optional[asyncpg.Pool] = None
_redis_client: Optional[redis.Redis] = None

async def get_db_pool() -> asyncpg.Pool:
    """Get or create database connection pool"""
    global _db_pool
    
    if _db_pool is None:
        try:
            config = get_database_config()
            _db_pool = await asyncpg.create_pool(
                host=config["host"],
                port=config["port"],
                database=config["database"],
                user=config["user"],
                password=config["password"],
                min_size=config["min_size"],
                max_size=config["max_size"],
                command_timeout=30,
                server_settings={
                    'application_name': 'product-catalog-service',
                }
            )
            logger.info(f"Database connection pool created: {config['host']}:{config['port']}")
        except Exception as e:
            logger.error(f"Failed to create database pool: {e}")
            raise
    
    return _db_pool

async def get_redis_client() -> redis.Redis:
    """Get or create Redis client"""
    global _redis_client
    
    if _redis_client is None:
        try:
            config = get_redis_config()
            _redis_client = redis.Redis(
                host=config["host"],
                port=config["port"],
                db=config["db"],
                password=config["password"],
                decode_responses=config["decode_responses"],
                socket_connect_timeout=5,
                socket_timeout=5,
                retry_on_timeout=True,
                health_check_interval=30,
            )
            
            # Test connection
            await _redis_client.ping()
            logger.info(f"Redis client created: {config['host']}:{config['port']}")
        except Exception as e:
            logger.error(f"Failed to create Redis client: {e}")
            raise
    
    return _redis_client

async def close_db_pool():
    """Close database connection pool"""
    global _db_pool
    if _db_pool:
        await _db_pool.close()
        _db_pool = None
        logger.info("Database connection pool closed")

async def close_redis_client():
    """Close Redis client"""
    global _redis_client
    if _redis_client:
        await _redis_client.close()
        _redis_client = None
        logger.info("Redis client closed")

class DatabaseManager:
    """Database connection context manager"""
    
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self.connection = None
    
    async def __aenter__(self):
        self.connection = await self.pool.acquire()
        return self.connection
    
    async def __aenter__(self):
        if self.connection:
            await self.pool.release(self.connection)

def get_db_manager(pool: asyncpg.Pool) -> DatabaseManager:
    """Get database connection manager"""
    return DatabaseManager(pool)