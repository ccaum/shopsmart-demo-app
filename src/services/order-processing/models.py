"""
Data models for Order Processing Service
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional, Dict, Any
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, ConfigDict
from bson import ObjectId


class PyObjectId(ObjectId):
    """Custom ObjectId type for Pydantic models."""
    
    @classmethod
    def __get_pydantic_json_schema__(cls, field_schema):
        field_schema.update(type="string")
        return field_schema

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type, handler):
        from pydantic_core import core_schema
        return core_schema.no_info_plain_validator_function(cls.validate)

    @classmethod
    def validate(cls, v):
        if not ObjectId.is_valid(v):
            raise ValueError("Invalid ObjectId")
        return ObjectId(v)


class OrderStatus(str, Enum):
    """Order status enumeration for luxury desk orders."""
    PENDING = "pending"
    CONFIRMED = "confirmed"
    CRAFTING = "crafting"
    SHIPPING = "shipping"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class ShippingAddress(BaseModel):
    """Shipping address model."""
    model_config = ConfigDict(populate_by_name=True)
    
    street: str = Field(..., min_length=1, max_length=200)
    city: str = Field(..., min_length=1, max_length=100)
    state: str = Field(..., min_length=2, max_length=50)
    zip_code: str = Field(..., min_length=5, max_length=10, alias="zipCode")
    country: str = Field(default="US", max_length=2)
    
    @field_validator("zip_code")
    @classmethod
    def validate_zip_code(cls, v):
        """Validate US zip code format."""
        import re
        if not re.match(r'^\d{5}(-\d{4})?$', v):
            raise ValueError("Invalid zip code format")
        return v


class OrderItem(BaseModel):
    """Individual item in an order."""
    model_config = ConfigDict(populate_by_name=True)
    
    product_id: str = Field(..., alias="productId")
    name: str = Field(..., min_length=1, max_length=200)
    price: float = Field(..., gt=0)
    quantity: int = Field(..., gt=0)
    crafting_time_months: Optional[int] = Field(None, alias="craftingTimeMonths", ge=1, le=24)
    artisan_name: Optional[str] = Field(None, alias="artisanName", max_length=100)
    material: Optional[str] = Field(None, max_length=100)
    style: Optional[str] = Field(None, max_length=50)
    customizations: Optional[Dict[str, Any]] = Field(default_factory=dict)
    
    @field_validator("price")
    @classmethod
    def validate_price(cls, v):
        """Ensure price has at most 2 decimal places."""
        return round(v, 2)


class Order(BaseModel):
    """Complete order model for database storage."""
    model_config = ConfigDict(
        populate_by_name=True,
        arbitrary_types_allowed=True,
        json_encoders={ObjectId: str}
    )
    
    id: Optional[PyObjectId] = Field(default_factory=PyObjectId, alias="_id")
    order_id: str = Field(..., alias="orderId")
    user_id: str = Field(..., alias="userId")
    items: List[OrderItem] = Field(..., min_length=1)
    total_amount: float = Field(..., gt=0, alias="totalAmount")
    shipping_address: ShippingAddress = Field(..., alias="shippingAddress")
    status: OrderStatus = Field(default=OrderStatus.PENDING)
    estimated_delivery: Optional[datetime] = Field(None, alias="estimatedDelivery")
    crafting_start_date: Optional[datetime] = Field(None, alias="craftingStartDate")
    tracking_info: Optional[Dict[str, Any]] = Field(default_factory=dict, alias="trackingInfo")
    created_at: datetime = Field(default_factory=datetime.utcnow, alias="createdAt")
    updated_at: datetime = Field(default_factory=datetime.utcnow, alias="updatedAt")
    
    @field_validator("total_amount")
    @classmethod
    def validate_total_amount(cls, v):
        """Ensure total amount has at most 2 decimal places."""
        return round(v, 2)
    
    @field_validator("estimated_delivery")
    @classmethod
    def validate_estimated_delivery(cls, v):
        """Ensure estimated delivery is in the future."""
        if v and v <= datetime.utcnow():
            raise ValueError("Estimated delivery must be in the future")
        return v
    
    @field_validator("items")
    @classmethod
    def validate_items_not_empty(cls, v):
        """Ensure items list is not empty."""
        if not v:
            raise ValueError("Order must contain at least one item")
        return v


class CreateOrderRequest(BaseModel):
    """Request model for creating a new order."""
    model_config = ConfigDict(populate_by_name=True)
    
    user_id: str = Field(..., alias="userId")
    items: List[OrderItem] = Field(..., min_length=1)
    shipping_address: ShippingAddress = Field(..., alias="shippingAddress")
    
    @field_validator("items")
    @classmethod
    def validate_items_not_empty(cls, v):
        """Ensure items list is not empty."""
        if not v:
            raise ValueError("Order must contain at least one item")
        return v


class OrderResponse(BaseModel):
    """Response model for order operations."""
    model_config = ConfigDict(populate_by_name=True)
    
    order_id: str = Field(..., alias="orderId")
    user_id: str = Field(..., alias="userId")
    items: List[OrderItem]
    total_amount: float = Field(..., alias="totalAmount")
    shipping_address: ShippingAddress = Field(..., alias="shippingAddress")
    status: OrderStatus
    estimated_delivery: Optional[datetime] = Field(None, alias="estimatedDelivery")
    crafting_start_date: Optional[datetime] = Field(None, alias="craftingStartDate")
    tracking_info: Optional[Dict[str, Any]] = Field(default_factory=dict, alias="trackingInfo")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")


class OrderStatusUpdate(BaseModel):
    """Model for updating order status."""
    model_config = ConfigDict(populate_by_name=True)
    
    status: OrderStatus
    updated_at: datetime = Field(default_factory=datetime.utcnow, alias="updatedAt")


class OrderListResponse(BaseModel):
    """Response model for order list operations."""
    model_config = ConfigDict(populate_by_name=True)
    
    orders: List[OrderResponse]
    total_count: int = Field(..., alias="totalCount")
    page: int = Field(default=1)
    page_size: int = Field(default=10, alias="pageSize")


class LuxuryOrderCreate(BaseModel):
    """Request model for creating luxury desk orders."""
    model_config = ConfigDict(populate_by_name=True)
    
    user_id: str = Field(..., alias="userId")
    items: List[OrderItem] = Field(..., min_length=1)
    shipping_address: ShippingAddress = Field(..., alias="shippingAddress")
    
    @field_validator("items")
    @classmethod
    def validate_luxury_items(cls, v):
        """Ensure all items have required luxury desk fields."""
        for item in v:
            if not item.crafting_time_months:
                raise ValueError("Crafting time is required for luxury desk orders")
            if not item.artisan_name:
                raise ValueError("Artisan name is required for luxury desk orders")
        return v


class TrackingInfo(BaseModel):
    """Tracking information for luxury orders."""
    model_config = ConfigDict(populate_by_name=True)
    
    carrier: Optional[str] = None
    tracking_number: Optional[str] = Field(None, alias="trackingNumber")
    estimated_delivery: Optional[datetime] = Field(None, alias="estimatedDelivery")
    delivery_notes: Optional[str] = Field(None, alias="deliveryNotes", max_length=500)


class OrderStatusUpdateRequest(BaseModel):
    """Enhanced model for updating order status with luxury features."""
    model_config = ConfigDict(populate_by_name=True)
    
    status: OrderStatus
    crafting_start_date: Optional[datetime] = Field(None, alias="craftingStartDate")
    estimated_delivery: Optional[datetime] = Field(None, alias="estimatedDelivery")
    tracking_info: Optional[TrackingInfo] = Field(None, alias="trackingInfo")
    notes: Optional[str] = Field(None, max_length=1000)
    
    @field_validator("crafting_start_date")
    @classmethod
    def validate_crafting_start_date(cls, v, info):
        """Validate crafting start date for crafting status."""
        status = info.data.get('status')
        if status == OrderStatus.CRAFTING and not v:
            raise ValueError("Crafting start date is required when status is 'crafting'")
        return v