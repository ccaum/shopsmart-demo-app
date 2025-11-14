"""
Data models for Product Catalog Service
"""

from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict, Any
from decimal import Decimal
from datetime import datetime
from enum import Enum

class AvailabilityStatus(str, Enum):
    """Product availability status"""
    IN_STOCK = "in_stock"
    OUT_OF_STOCK = "out_of_stock"

class StockLevel(str, Enum):
    """Stock level indicators"""
    HIGH = "high"
    LOW = "low"
    NONE = "none"

class Product(BaseModel):
    """Product model"""
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    price: Decimal = Field(..., ge=0, decimal_places=2)
    category: str = Field(..., min_length=1, max_length=100)
    inventory_count: int = Field(default=0, ge=0)
    image_url: Optional[str] = Field(None, max_length=500)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    availability_status: Optional[AvailabilityStatus] = None
    stock_level: Optional[StockLevel] = None
    
    # Artisan desk specific fields
    material: Optional[str] = Field(None, max_length=100)
    style: Optional[str] = Field(None, max_length=50)
    crafting_time_months: Optional[int] = Field(None, ge=1, le=60)
    artisan_name: Optional[str] = Field(None, max_length=100)
    authenticity_certificate: Optional[str] = Field(None, max_length=255)
    
    @validator('price', pre=True)
    def validate_price(cls, v):
        """Validate price format"""
        if isinstance(v, str):
            return Decimal(v)
        return v
    
    class Config:
        json_encoders = {
            Decimal: lambda v: float(v),
            datetime: lambda v: v.isoformat()
        }

class ProductSummary(BaseModel):
    """Simplified product model for listings"""
    id: str
    name: str
    price: Decimal
    category: str
    inventory_count: int
    image_url: Optional[str] = None
    availability_status: AvailabilityStatus
    
    # Artisan desk specific fields for listings
    material: Optional[str] = None
    style: Optional[str] = None
    crafting_time_months: Optional[int] = None
    artisan_name: Optional[str] = None
    
    class Config:
        json_encoders = {
            Decimal: lambda v: float(v)
        }

class ProductList(BaseModel):
    """Paginated product list response"""
    products: List[ProductSummary]
    total_count: int
    page: int
    page_size: int
    total_pages: int
    has_next: bool
    has_previous: bool

class ProductCategory(BaseModel):
    """Product category model"""
    name: str
    product_count: int

class ProductSearchRequest(BaseModel):
    """Product search request parameters"""
    query: Optional[str] = None
    category: Optional[str] = None
    min_price: Optional[Decimal] = None
    max_price: Optional[Decimal] = None
    in_stock_only: bool = False
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)
    sort_by: str = Field(default="name", regex="^(name|price|created_at|inventory_count)$")
    sort_order: str = Field(default="asc", regex="^(asc|desc)$")
    
    # Artisan desk filtering parameters
    material: Optional[str] = None
    style: Optional[str] = None

class InventoryCheckRequest(BaseModel):
    """Inventory check request for order service"""
    product_id: str
    quantity: int = Field(..., ge=1)

class InventoryCheckResponse(BaseModel):
    """Inventory check response"""
    product_id: str
    available: bool
    available_quantity: int
    requested_quantity: int
    product_name: Optional[str] = None
    price: Optional[Decimal] = None
    
    class Config:
        json_encoders = {
            Decimal: lambda v: float(v)
        }

class HealthCheckResponse(BaseModel):
    """Health check response"""
    status: str
    service: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    
    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class InventoryReservationRequest(BaseModel):
    """Inventory reservation request"""
    quantity: int = Field(..., ge=1)
    timeout_minutes: int = Field(default=15, ge=1, le=60)

class InventoryReservationResponse(BaseModel):
    """Inventory reservation response"""
    product_id: str
    reservation_id: str
    quantity: int
    expires_at: datetime
    success: bool
    message: Optional[str] = None
    
    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class MaterialsResponse(BaseModel):
    """Response model for materials list"""
    materials: List[str]

class StylesResponse(BaseModel):
    """Response model for styles list"""
    styles: List[str]

class ErrorResponse(BaseModel):
    """Error response model"""
    error: str
    message: str
    details: Optional[Dict[str, Any]] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    
    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }