"""
Product service for database operations
"""

import asyncpg
import logging
import uuid
from typing import List, Optional, Tuple
from decimal import Decimal
from datetime import datetime, timedelta
from models import (
    Product, ProductSummary, ProductSearchRequest, InventoryCheckResponse,
    InventoryReservationRequest, InventoryReservationResponse
)

logger = logging.getLogger(__name__)

class ProductService:
    """Service for product database operations"""
    
    def __init__(self, db_pool: asyncpg.Pool):
        self.db_pool = db_pool
    
    async def get_products(
        self, 
        search_request: ProductSearchRequest
    ) -> Tuple[List[ProductSummary], int]:
        """Get paginated list of products with search and filtering"""
        
        # Build WHERE clause
        where_conditions = []
        params = []
        param_count = 0
        
        if search_request.query:
            param_count += 1
            where_conditions.append(
                f"to_tsvector('english', name || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', ${param_count})"
            )
            params.append(search_request.query)
        
        if search_request.category:
            param_count += 1
            where_conditions.append(f"category = ${param_count}")
            params.append(search_request.category)
        
        if search_request.min_price is not None:
            param_count += 1
            where_conditions.append(f"price >= ${param_count}")
            params.append(search_request.min_price)
        
        if search_request.max_price is not None:
            param_count += 1
            where_conditions.append(f"price <= ${param_count}")
            params.append(search_request.max_price)
        
        if search_request.in_stock_only:
            where_conditions.append("inventory_count > 0")
        
        # Artisan desk filtering
        if search_request.material:
            param_count += 1
            where_conditions.append(f"material = ${param_count}")
            params.append(search_request.material)
        
        if search_request.style:
            param_count += 1
            where_conditions.append(f"style = ${param_count}")
            params.append(search_request.style)
        
        where_clause = "WHERE " + " AND ".join(where_conditions) if where_conditions else ""
        
        # Build ORDER BY clause
        sort_column = search_request.sort_by
        sort_direction = search_request.sort_order.upper()
        order_clause = f"ORDER BY {sort_column} {sort_direction}"
        
        # Calculate pagination
        offset = (search_request.page - 1) * search_request.page_size
        param_count += 1
        limit_param = param_count
        param_count += 1
        offset_param = param_count
        params.extend([search_request.page_size, offset])
        
        # Build queries
        count_query = f"""
            SELECT COUNT(*) 
            FROM product_catalog 
            {where_clause}
        """
        
        products_query = f"""
            SELECT id, name, price, category, inventory_count, image_url, availability_status,
                   material, style, crafting_time_months, artisan_name
            FROM product_catalog 
            {where_clause}
            {order_clause}
            LIMIT ${limit_param} OFFSET ${offset_param}
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                # Get total count
                if where_conditions:
                    total_count = await conn.fetchval(count_query, *params[:-2])
                else:
                    total_count = await conn.fetchval("SELECT COUNT(*) FROM product_catalog")
                
                # Get products
                rows = await conn.fetch(products_query, *params)
                
                products = [
                    ProductSummary(
                        id=str(row['id']),
                        name=row['name'],
                        price=row['price'],
                        category=row['category'],
                        inventory_count=row['inventory_count'],
                        image_url=row['image_url'],
                        availability_status=row['availability_status'],
                        material=row['material'],
                        style=row['style'],
                        crafting_time_months=row['crafting_time_months'],
                        artisan_name=row['artisan_name']
                    )
                    for row in rows
                ]
                
                return products, total_count
                
            except Exception as e:
                logger.error(f"Error fetching products: {e}")
                raise
    
    async def get_product_by_id(self, product_id: str) -> Optional[Product]:
        """Get product by ID"""
        query = """
            SELECT id, name, description, price, category, inventory_count, 
                   image_url, created_at, updated_at, availability_status, stock_level,
                   material, style, crafting_time_months, artisan_name, authenticity_certificate
            FROM product_catalog 
            WHERE id = $1
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                row = await conn.fetchrow(query, product_id)
                if not row:
                    return None
                
                return Product(
                    id=str(row['id']),
                    name=row['name'],
                    description=row['description'],
                    price=row['price'],
                    category=row['category'],
                    inventory_count=row['inventory_count'],
                    image_url=row['image_url'],
                    created_at=row['created_at'],
                    updated_at=row['updated_at'],
                    availability_status=row['availability_status'],
                    stock_level=row['stock_level'],
                    material=row['material'],
                    style=row['style'],
                    crafting_time_months=row['crafting_time_months'],
                    artisan_name=row['artisan_name'],
                    authenticity_certificate=row['authenticity_certificate']
                )
                
            except Exception as e:
                logger.error(f"Error fetching product {product_id}: {e}")
                raise
    
    async def get_categories(self) -> List[dict]:
        """Get all product categories with counts"""
        query = """
            SELECT category, COUNT(*) as product_count
            FROM product_catalog 
            GROUP BY category 
            ORDER BY category
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                rows = await conn.fetch(query)
                return [
                    {"name": row['category'], "product_count": row['product_count']}
                    for row in rows
                ]
            except Exception as e:
                logger.error(f"Error fetching categories: {e}")
                raise
    
    async def get_materials(self) -> List[str]:
        """Get unique materials for filtering"""
        query = """
            SELECT DISTINCT material
            FROM product_catalog 
            WHERE material IS NOT NULL
            ORDER BY material
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                rows = await conn.fetch(query)
                return [row['material'] for row in rows]
            except Exception as e:
                logger.error(f"Error fetching materials: {e}")
                raise
    
    async def get_styles(self) -> List[str]:
        """Get unique styles for filtering"""
        query = """
            SELECT DISTINCT style
            FROM product_catalog 
            WHERE style IS NOT NULL
            ORDER BY style
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                rows = await conn.fetch(query)
                return [row['style'] for row in rows]
            except Exception as e:
                logger.error(f"Error fetching styles: {e}")
                raise
    
    async def check_inventory(self, product_id: str, quantity: int) -> InventoryCheckResponse:
        """Check product inventory availability"""
        query = """
            SELECT id, name, price, inventory_count
            FROM product_catalog 
            WHERE id = $1
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                row = await conn.fetchrow(query, product_id)
                if not row:
                    return InventoryCheckResponse(
                        product_id=product_id,
                        available=False,
                        available_quantity=0,
                        requested_quantity=quantity
                    )
                
                available_quantity = row['inventory_count']
                is_available = available_quantity >= quantity
                
                return InventoryCheckResponse(
                    product_id=product_id,
                    available=is_available,
                    available_quantity=available_quantity,
                    requested_quantity=quantity,
                    product_name=row['name'],
                    price=row['price']
                )
                
            except Exception as e:
                logger.error(f"Error checking inventory for product {product_id}: {e}")
                raise
    
    async def update_inventory(self, product_id: str, quantity_change: int) -> bool:
        """Update product inventory (for order processing)"""
        query = """
            UPDATE product_catalog 
            SET inventory_count = inventory_count + $2,
                updated_at = NOW()
            WHERE id = $1 AND inventory_count + $2 >= 0
            RETURNING inventory_count
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                result = await conn.fetchval(query, product_id, quantity_change)
                return result is not None
            except Exception as e:
                logger.error(f"Error updating inventory for product {product_id}: {e}")
                raise
    
    async def reserve_inventory(
        self, 
        product_id: str, 
        request: InventoryReservationRequest
    ) -> InventoryReservationResponse:
        """Reserve inventory for checkout process"""
        
        # Generate unique reservation ID
        reservation_id = str(uuid.uuid4())
        expires_at = datetime.utcnow() + timedelta(minutes=request.timeout_minutes)
        
        # First, check if we have enough inventory
        check_query = """
            SELECT inventory_count, name
            FROM product_catalog 
            WHERE id = $1
        """
        
        # Create reservation record (we'll use Redis for temporary storage)
        async with self.db_pool.acquire() as conn:
            try:
                # Check current inventory
                row = await conn.fetchrow(check_query, product_id)
                if not row:
                    return InventoryReservationResponse(
                        product_id=product_id,
                        reservation_id=reservation_id,
                        quantity=request.quantity,
                        expires_at=expires_at,
                        success=False,
                        message="Product not found"
                    )
                
                available_inventory = row['inventory_count']
                
                # Check if we have enough inventory
                if available_inventory < request.quantity:
                    return InventoryReservationResponse(
                        product_id=product_id,
                        reservation_id=reservation_id,
                        quantity=request.quantity,
                        expires_at=expires_at,
                        success=False,
                        message=f"Insufficient inventory. Available: {available_inventory}, Requested: {request.quantity}"
                    )
                
                # Reserve the inventory (temporarily reduce available count)
                reserve_query = """
                    UPDATE product_catalog 
                    SET inventory_count = inventory_count - $2
                    WHERE id = $1 AND inventory_count >= $2
                    RETURNING inventory_count
                """
                
                result = await conn.fetchval(reserve_query, product_id, request.quantity)
                if result is None:
                    return InventoryReservationResponse(
                        product_id=product_id,
                        reservation_id=reservation_id,
                        quantity=request.quantity,
                        expires_at=expires_at,
                        success=False,
                        message="Unable to reserve inventory - concurrent modification"
                    )
                
                logger.info(f"Reserved {request.quantity} units of product {product_id}, reservation {reservation_id}")
                
                return InventoryReservationResponse(
                    product_id=product_id,
                    reservation_id=reservation_id,
                    quantity=request.quantity,
                    expires_at=expires_at,
                    success=True,
                    message="Inventory reserved successfully"
                )
                
            except Exception as e:
                logger.error(f"Error reserving inventory for product {product_id}: {e}")
                raise
    
    async def release_reservation(self, product_id: str, reservation_id: str, quantity: int) -> bool:
        """Release inventory reservation (restore inventory)"""
        
        release_query = """
            UPDATE product_catalog 
            SET inventory_count = inventory_count + $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING inventory_count
        """
        
        async with self.db_pool.acquire() as conn:
            try:
                result = await conn.fetchval(release_query, product_id, quantity)
                if result is not None:
                    logger.info(f"Released reservation {reservation_id} for product {product_id}, restored {quantity} units")
                    return True
                return False
            except Exception as e:
                logger.error(f"Error releasing reservation {reservation_id} for product {product_id}: {e}")
                raise
    
    async def cleanup_expired_reservations(self) -> int:
        """Cleanup expired reservations - this would be called by a background task"""
        # In a real implementation, we'd store reservations in Redis with TTL
        # and have a background task to clean them up
        # For now, this is a placeholder that would work with a reservations table
        
        logger.info("Cleanup expired reservations called - placeholder implementation")
        return 0