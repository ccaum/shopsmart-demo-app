"""
Cache service for Redis operations
"""

import redis.asyncio as redis
import json
import logging
from typing import Optional, List, Any
from config import get_settings

logger = logging.getLogger(__name__)

class CacheService:
    """Service for Redis cache operations"""
    
    def __init__(self, redis_client: redis.Redis):
        self.redis_client = redis_client
        self.settings = get_settings()
    
    def _get_cache_key(self, prefix: str, identifier: str) -> str:
        """Generate cache key with prefix"""
        return f"{self.settings.app_name}:{prefix}:{identifier}"
    
    async def get_cached_data(self, key: str) -> Optional[Any]:
        """Get data from cache"""
        try:
            cached_data = await self.redis_client.get(key)
            if cached_data:
                return json.loads(cached_data)
            return None
        except Exception as e:
            logger.warning(f"Cache get error for key {key}: {e}")
            return None
    
    async def set_cached_data(self, key: str, data: Any, ttl: int) -> bool:
        """Set data in cache with TTL"""
        try:
            serialized_data = json.dumps(data, default=str)
            await self.redis_client.setex(key, ttl, serialized_data)
            return True
        except Exception as e:
            logger.warning(f"Cache set error for key {key}: {e}")
            return False
    
    async def delete_cached_data(self, key: str) -> bool:
        """Delete data from cache"""
        try:
            await self.redis_client.delete(key)
            return True
        except Exception as e:
            logger.warning(f"Cache delete error for key {key}: {e}")
            return False
    
    async def get_product(self, product_id: str) -> Optional[dict]:
        """Get cached product data"""
        cache_key = self._get_cache_key("product", product_id)
        return await self.get_cached_data(cache_key)
    
    async def set_product(self, product_id: str, product_data: dict) -> bool:
        """Cache product data"""
        cache_key = self._get_cache_key("product", product_id)
        return await self.set_cached_data(
            cache_key, 
            product_data, 
            self.settings.cache_ttl_products
        )
    
    async def get_products_list(self, cache_key_suffix: str) -> Optional[dict]:
        """Get cached products list"""
        cache_key = self._get_cache_key("products", cache_key_suffix)
        return await self.get_cached_data(cache_key)
    
    async def set_products_list(self, cache_key_suffix: str, products_data: dict) -> bool:
        """Cache products list"""
        cache_key = self._get_cache_key("products", cache_key_suffix)
        return await self.set_cached_data(
            cache_key, 
            products_data, 
            self.settings.cache_ttl_search
        )
    
    async def get_categories(self) -> Optional[List[dict]]:
        """Get cached categories"""
        cache_key = self._get_cache_key("categories", "all")
        return await self.get_cached_data(cache_key)
    
    async def set_categories(self, categories_data: List[dict]) -> bool:
        """Cache categories"""
        cache_key = self._get_cache_key("categories", "all")
        return await self.set_cached_data(
            cache_key, 
            categories_data, 
            self.settings.cache_ttl_categories
        )
    
    async def invalidate_product(self, product_id: str) -> bool:
        """Invalidate product cache"""
        cache_key = self._get_cache_key("product", product_id)
        return await self.delete_cached_data(cache_key)
    
    async def invalidate_products_lists(self) -> bool:
        """Invalidate all product list caches"""
        try:
            pattern = self._get_cache_key("products", "*")
            keys = await self.redis_client.keys(pattern)
            if keys:
                await self.redis_client.delete(*keys)
            return True
        except Exception as e:
            logger.warning(f"Error invalidating product lists: {e}")
            return False
    
    async def invalidate_categories(self) -> bool:
        """Invalidate categories cache"""
        cache_key = self._get_cache_key("categories", "all")
        return await self.delete_cached_data(cache_key)
    
    async def warm_cache(self, popular_product_ids: List[str]) -> None:
        """Warm cache with popular products (placeholder for implementation)"""
        # This would be implemented to pre-load popular products into cache
        # For now, it's a placeholder that could be called during startup
        logger.info(f"Cache warming requested for {len(popular_product_ids)} products")
    
    def generate_search_cache_key(self, search_params: dict) -> str:
        """Generate cache key for search results"""
        # Create a deterministic key from search parameters
        key_parts = []
        for key in sorted(search_params.keys()):
            if search_params[key] is not None:
                key_parts.append(f"{key}:{search_params[key]}")
        
        cache_key_suffix = "_".join(key_parts) if key_parts else "default"
        return cache_key_suffix