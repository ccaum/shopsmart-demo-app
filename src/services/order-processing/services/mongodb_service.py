"""
MongoDB service for Order Processing
Handles database connections, operations, and error handling.
"""

import logging
from typing import List, Optional, Dict, Any
from datetime import datetime

import motor.motor_asyncio
from pymongo.errors import (
    ConnectionFailure, 
    ServerSelectionTimeoutError,
    DuplicateKeyError,
    OperationFailure
)
from bson import ObjectId
from opentelemetry import trace

from models import Order, OrderStatus, OrderResponse, OrderListResponse
from middleware.logging_middleware import get_correlation_id

logger = logging.getLogger(__name__)
tracer = trace.get_tracer(__name__)


class MongoDBService:
    """MongoDB service for order management operations."""
    
    def __init__(self, mongodb_url: str, database_name: str = "orders"):
        """Initialize MongoDB service with connection parameters."""
        self.mongodb_url = mongodb_url
        self.database_name = database_name
        self.client: Optional[motor.motor_asyncio.AsyncIOMotorClient] = None
        self.database: Optional[motor.motor_asyncio.AsyncIOMotorDatabase] = None
        self.collection: Optional[motor.motor_asyncio.AsyncIOMotorCollection] = None
    
    async def connect(self) -> None:
        """Establish connection to MongoDB."""
        try:
            self.client = motor.motor_asyncio.AsyncIOMotorClient(
                self.mongodb_url,
                serverSelectionTimeoutMS=5000,
                connectTimeoutMS=10000,
                socketTimeoutMS=10000,
                maxPoolSize=10,
                minPoolSize=1
            )
            
            # Test the connection
            await self.client.admin.command('ping')
            
            self.database = self.client[self.database_name]
            self.collection = self.database.orders
            
            # Create indexes for better performance
            await self._create_indexes()
            
            logger.info(
                f"Connected to MongoDB: {self.database_name}",
                extra={"correlation_id": get_correlation_id()}
            )
            
        except (ConnectionFailure, ServerSelectionTimeoutError) as e:
            logger.error(
                f"Failed to connect to MongoDB: {str(e)}",
                extra={"correlation_id": get_correlation_id()}
            )
            raise
    
    async def disconnect(self) -> None:
        """Close MongoDB connection."""
        if self.client:
            self.client.close()
            logger.info(
                "Disconnected from MongoDB",
                extra={"correlation_id": get_correlation_id()}
            )
    
    async def health_check(self) -> bool:
        """Check MongoDB connection health."""
        try:
            if not self.client:
                return False
            
            await self.client.admin.command('ping')
            return True
            
        except Exception as e:
            logger.error(
                f"MongoDB health check failed: {str(e)}",
                extra={"correlation_id": get_correlation_id()}
            )
            return False
    
    async def _create_indexes(self) -> None:
        """Create database indexes for optimal performance."""
        try:
            # Index on user_id for user order queries
            await self.collection.create_index("userId")
            
            # Index on order_id for unique order lookups
            await self.collection.create_index("orderId", unique=True)
            
            # Index on created_at for chronological sorting
            await self.collection.create_index("createdAt")
            
            # Index on status for status-based queries
            await self.collection.create_index("status")
            
            # Index on estimated_delivery for delivery tracking
            await self.collection.create_index("estimatedDelivery")
            
            # Compound index for user orders by date
            await self.collection.create_index([("userId", 1), ("createdAt", -1)])
            
            # Compound index for status and crafting date
            await self.collection.create_index([("status", 1), ("craftingStartDate", 1)])
            
            # Compound index for luxury order tracking
            await self.collection.create_index([("status", 1), ("estimatedDelivery", 1)])
            
            logger.info(
                "MongoDB indexes created successfully",
                extra={"correlation_id": get_correlation_id()}
            )
            
        except Exception as e:
            logger.warning(
                f"Failed to create indexes: {str(e)}",
                extra={"correlation_id": get_correlation_id()}
            )
    
    async def create_order(self, order: Order) -> str:
        """Create a new order in the database."""
        correlation_id = get_correlation_id()
        
        with tracer.start_as_current_span("mongodb.create_order") as span:
            span.set_attribute("db.system", "mongodb")
            span.set_attribute("db.operation", "insert_one")
            span.set_attribute("order.id", order.order_id)
            span.set_attribute("user.id", order.user_id)
            
            try:
                # Convert Pydantic model to dict for MongoDB
                order_dict = order.dict(by_alias=True, exclude={"id"})
                
                # Insert the order
                result = await self.collection.insert_one(order_dict)
                
                span.set_attribute("db.success", True)
                logger.info(
                    f"Order created successfully: {order.order_id}",
                    extra={
                        "correlation_id": correlation_id,
                        "order_id": order.order_id,
                        "user_id": order.user_id
                    }
                )
                
                return str(result.inserted_id)
                
            except DuplicateKeyError:
                span.set_attribute("db.success", False)
                span.set_attribute("error.type", "DuplicateKeyError")
                logger.error(
                    f"Duplicate order ID: {order.order_id}",
                    extra={"correlation_id": correlation_id}
                )
                raise ValueError(f"Order with ID {order.order_id} already exists")
                
            except Exception as e:
                span.set_attribute("db.success", False)
                span.set_attribute("error.type", type(e).__name__)
                logger.error(
                f"Failed to create order: {str(e)}",
                extra={
                    "correlation_id": correlation_id,
                    "order_id": order.order_id
                }
            )
            raise
    
    async def get_order_by_id(self, order_id: str) -> Optional[OrderResponse]:
        """Retrieve an order by its ID."""
        correlation_id = get_correlation_id()
        
        try:
            order_doc = await self.collection.find_one({"orderId": order_id})
            
            if not order_doc:
                logger.info(
                    f"Order not found: {order_id}",
                    extra={"correlation_id": correlation_id}
                )
                return None
            
            # Convert MongoDB document to response model
            return self._doc_to_order_response(order_doc)
            
        except Exception as e:
            logger.error(
                f"Failed to retrieve order {order_id}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise
    
    async def get_user_orders(
        self, 
        user_id: str, 
        page: int = 1, 
        page_size: int = 10
    ) -> OrderListResponse:
        """Retrieve orders for a specific user with pagination."""
        correlation_id = get_correlation_id()
        
        try:
            skip = (page - 1) * page_size
            
            # Get total count
            total_count = await self.collection.count_documents({"userId": user_id})
            
            # Get paginated orders
            cursor = self.collection.find({"userId": user_id}).sort("createdAt", -1).skip(skip).limit(page_size)
            orders_docs = await cursor.to_list(length=page_size)
            
            # Convert to response models
            orders = [self._doc_to_order_response(doc) for doc in orders_docs]
            
            logger.info(
                f"Retrieved {len(orders)} orders for user {user_id}",
                extra={
                    "correlation_id": correlation_id,
                    "user_id": user_id,
                    "page": page,
                    "total_count": total_count
                }
            )
            
            return OrderListResponse(
                orders=orders,
                totalCount=total_count,
                page=page,
                pageSize=page_size
            )
            
        except Exception as e:
            logger.error(
                f"Failed to retrieve orders for user {user_id}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise
    
    async def update_order_status(self, order_id: str, status: OrderStatus) -> bool:
        """Update the status of an order."""
        correlation_id = get_correlation_id()
        
        try:
            result = await self.collection.update_one(
                {"orderId": order_id},
                {
                    "$set": {
                        "status": status.value,
                        "updatedAt": datetime.utcnow()
                    }
                }
            )
            
            if result.modified_count == 0:
                logger.warning(
                    f"Order not found for status update: {order_id}",
                    extra={"correlation_id": correlation_id}
                )
                return False
            
            logger.info(
                f"Order status updated: {order_id} -> {status.value}",
                extra={
                    "correlation_id": correlation_id,
                    "order_id": order_id,
                    "new_status": status.value
                }
            )
            
            return True
            
        except Exception as e:
            logger.error(
                f"Failed to update order status {order_id}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise
    
    async def update_luxury_order(
        self, 
        order_id: str, 
        status: OrderStatus,
        crafting_start_date: Optional[datetime] = None,
        estimated_delivery: Optional[datetime] = None,
        tracking_info: Optional[Dict[str, Any]] = None,
        notes: Optional[str] = None
    ) -> bool:
        """Update luxury order with enhanced tracking information."""
        correlation_id = get_correlation_id()
        
        try:
            update_fields = {
                "status": status.value,
                "updatedAt": datetime.utcnow()
            }
            
            # Add optional fields if provided
            if crafting_start_date:
                update_fields["craftingStartDate"] = crafting_start_date
            
            if estimated_delivery:
                update_fields["estimatedDelivery"] = estimated_delivery
            
            if tracking_info:
                update_fields["trackingInfo"] = tracking_info
            
            if notes:
                # Store notes in tracking info or separate field
                if "trackingInfo" not in update_fields:
                    update_fields["trackingInfo"] = {}
                update_fields["trackingInfo"]["notes"] = notes
            
            result = await self.collection.update_one(
                {"orderId": order_id},
                {"$set": update_fields}
            )
            
            if result.modified_count == 0:
                logger.warning(
                    f"Order not found for luxury update: {order_id}",
                    extra={"correlation_id": correlation_id}
                )
                return False
            
            logger.info(
                f"Luxury order updated: {order_id} -> {status.value}",
                extra={
                    "correlation_id": correlation_id,
                    "order_id": order_id,
                    "new_status": status.value,
                    "has_crafting_date": crafting_start_date is not None,
                    "has_delivery_estimate": estimated_delivery is not None
                }
            )
            
            return True
            
        except Exception as e:
            logger.error(
                f"Failed to update luxury order {order_id}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise
    
    async def get_orders_by_status(
        self, 
        status: OrderStatus, 
        page: int = 1, 
        page_size: int = 10
    ) -> OrderListResponse:
        """Get orders filtered by status with pagination."""
        correlation_id = get_correlation_id()
        
        try:
            skip = (page - 1) * page_size
            
            # Get total count for status
            total_count = await self.collection.count_documents({"status": status.value})
            
            # Get paginated orders by status
            cursor = self.collection.find({"status": status.value}).sort("createdAt", -1).skip(skip).limit(page_size)
            orders_docs = await cursor.to_list(length=page_size)
            
            # Convert to response models
            orders = [self._doc_to_order_response(doc) for doc in orders_docs]
            
            logger.info(
                f"Retrieved {len(orders)} orders with status {status.value}",
                extra={
                    "correlation_id": correlation_id,
                    "status": status.value,
                    "page": page,
                    "total_count": total_count
                }
            )
            
            return OrderListResponse(
                orders=orders,
                totalCount=total_count,
                page=page,
                pageSize=page_size
            )
            
        except Exception as e:
            logger.error(
                f"Failed to retrieve orders by status {status.value}: {str(e)}",
                extra={"correlation_id": correlation_id}
            )
            raise
    
    def _doc_to_order_response(self, doc: Dict[str, Any]) -> OrderResponse:
        """Convert MongoDB document to OrderResponse model."""
        # Convert ObjectId to string and handle field mapping
        doc["_id"] = str(doc["_id"])
        
        return OrderResponse(**doc)