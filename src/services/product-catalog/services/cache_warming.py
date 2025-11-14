"""
Cache warming service for popular products
"""

import asyncio
import logging
from typing import List
from services.cache_service import CacheService
from services.product_service import ProductService

logger = logging.getLogger(__name__)

class CacheWarmingService:
    """Service for warming cache with popular products"""
    
    def __init__(self, product_service: ProductService, cache_service: CacheService):
        self.product_service = product_service
        self.cache_service = cache_service
    
    async def warm_popular_products(self) -> None:
        """Warm cache with popular products based on inventory levels"""
        try:
            # Get popular products (high inventory suggests popularity)
            popular_products = await self._get_popular_products()
            
            logger.info(f"Starting cache warming for {len(popular_products)} popular products")
            
            # Warm product details cache
            tasks = []
            for product_id in popular_products:
                task = self._warm_product_cache(product_id)
                tasks.append(task)
            
            # Execute warming tasks concurrently
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Count successes
            successes = sum(1 for result in results if result is True)
            logger.info(f"Cache warming completed: {successes}/{len(popular_products)} products cached")
            
        except Exception as e:
            logger.error(f"Cache warming failed: {e}")
    
    async def warm_categories_cache(self) -> None:
        """Warm categories cache"""
        try:
            categories = await self.product_service.get_categories()
            await self.cache_service.set_categories(categories)
            logger.info("Categories cache warmed successfully")
        except Exception as e:
            logger.error(f"Failed to warm categories cache: {e}")
    
    async def warm_common_searches(self) -> None:
        """Warm cache with common search patterns"""
        try:
            # Common search patterns to pre-cache
            common_searches = [
                {"category": "Electronics", "page": 1, "page_size": 20, "sort_by": "name", "sort_order": "asc"},
                {"category": "Clothing", "page": 1, "page_size": 20, "sort_by": "name", "sort_order": "asc"},
                {"category": "Home & Garden", "page": 1, "page_size": 20, "sort_by": "name", "sort_order": "asc"},
                {"category": "Books", "page": 1, "page_size": 20, "sort_by": "name", "sort_order": "asc"},
                {"in_stock_only": True, "page": 1, "page_size": 20, "sort_by": "name", "sort_order": "asc"},
                {"page": 1, "page_size": 20, "sort_by": "price", "sort_order": "asc"},
                {"page": 1, "page_size": 20, "sort_by": "price", "sort_order": "desc"},
            ]
            
            logger.info(f"Starting cache warming for {len(common_searches)} common searches")
            
            tasks = []
            for search_params in common_searches:
                task = self._warm_search_cache(search_params)
                tasks.append(task)
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            successes = sum(1 for result in results if result is True)
            logger.info(f"Search cache warming completed: {successes}/{len(common_searches)} searches cached")
            
        except Exception as e:
            logger.error(f"Search cache warming failed: {e}")
    
    async def _get_popular_products(self) -> List[str]:
        """Get list of popular product IDs based on inventory levels"""
        try:
            # Query for products with high inventory (suggests popularity)
            query = """
                SELECT id 
                FROM products 
                WHERE inventory_count > 20 
                ORDER BY inventory_count DESC, created_at DESC 
                LIMIT 50
            """
            
            async with self.product_service.db_pool.acquire() as conn:
                rows = await conn.fetch(query)
                return [str(row['id']) for row in rows]
                
        except Exception as e:
            logger.error(f"Failed to get popular products: {e}")
            return []
    
    async def _warm_product_cache(self, product_id: str) -> bool:
        """Warm cache for a specific product"""
        try:
            product = await self.product_service.get_product_by_id(product_id)
            if product:
                await self.cache_service.set_product(product_id, product.dict())
                return True
            return False
        except Exception as e:
            logger.warning(f"Failed to warm cache for product {product_id}: {e}")
            return False
    
    async def _warm_search_cache(self, search_params: dict) -> bool:
        """Warm cache for a specific search"""
        try:
            from models import ProductSearchRequest
            
            search_request = ProductSearchRequest(**search_params)
            products, total_count = await self.product_service.get_products(search_request)
            
            # Calculate pagination info
            page = search_params.get('page', 1)
            page_size = search_params.get('page_size', 20)
            total_pages = (total_count + page_size - 1) // page_size
            has_next = page < total_pages
            has_previous = page > 1
            
            # Create result
            from models import ProductList
            result = ProductList(
                products=products,
                total_count=total_count,
                page=page,
                page_size=page_size,
                total_pages=total_pages,
                has_next=has_next,
                has_previous=has_previous
            )
            
            # Cache the result
            cache_key_suffix = self.cache_service.generate_search_cache_key(search_params)
            await self.cache_service.set_products_list(cache_key_suffix, result.dict())
            return True
            
        except Exception as e:
            logger.warning(f"Failed to warm search cache for {search_params}: {e}")
            return False