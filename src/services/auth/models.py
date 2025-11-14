"""
Data models for User Authentication Service
Enhanced with customer profiles and shopping cart management
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any
from datetime import datetime
from decimal import Decimal


@dataclass
class Address:
    """Address model for shipping and billing"""
    street: str
    city: str
    state: str
    postal_code: str
    country: str = "US"
    is_default: bool = False
    address_type: str = "shipping"  # shipping or billing


@dataclass
class CustomerProfile:
    """Enhanced customer profile with personal information"""
    first_name: str
    last_name: str
    phone: Optional[str] = None
    shipping_addresses: List[Address] = field(default_factory=list)
    billing_addresses: List[Address] = field(default_factory=list)
    
    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


@dataclass
class CustomerPreferences:
    """Customer preferences for personalized experience"""
    favorite_styles: List[str] = field(default_factory=list)
    price_range: Dict[str, int] = field(default_factory=lambda: {'min': 0, 'max': 100000})
    material_preferences: List[str] = field(default_factory=list)
    newsletter_subscribed: bool = False


@dataclass
class Customer:
    """Enhanced customer model with profile and preferences"""
    user_id: str
    username: str
    email: str
    password_hash: str
    profile: CustomerProfile
    preferences: CustomerPreferences
    created_at: datetime
    last_login: Optional[datetime] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert customer to dictionary for DynamoDB storage"""
        return {
            'userId': self.user_id,
            'username': self.username,
            'email': self.email,
            'passwordHash': self.password_hash,
            'profile': {
                'firstName': self.profile.first_name,
                'lastName': self.profile.last_name,
                'phone': self.profile.phone,
                'shippingAddresses': [
                    {
                        'street': addr.street,
                        'city': addr.city,
                        'state': addr.state,
                        'postalCode': addr.postal_code,
                        'country': addr.country,
                        'isDefault': addr.is_default,
                        'addressType': addr.address_type
                    } for addr in self.profile.shipping_addresses
                ],
                'billingAddresses': [
                    {
                        'street': addr.street,
                        'city': addr.city,
                        'state': addr.state,
                        'postalCode': addr.postal_code,
                        'country': addr.country,
                        'isDefault': addr.is_default,
                        'addressType': addr.address_type
                    } for addr in self.profile.billing_addresses
                ]
            },
            'preferences': {
                'favoriteStyles': self.preferences.favorite_styles,
                'priceRange': self.preferences.price_range,
                'materialPreferences': self.preferences.material_preferences,
                'newsletterSubscribed': self.preferences.newsletter_subscribed
            },
            'createdAt': self.created_at.isoformat(),
            'lastLogin': self.last_login.isoformat() if self.last_login else None
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Customer':
        """Create customer from DynamoDB data"""
        profile_data = data.get('profile', {})
        preferences_data = data.get('preferences', {})
        
        # Parse addresses
        shipping_addresses = []
        for addr_data in profile_data.get('shippingAddresses', []):
            shipping_addresses.append(Address(
                street=addr_data['street'],
                city=addr_data['city'],
                state=addr_data['state'],
                postal_code=addr_data['postalCode'],
                country=addr_data.get('country', 'US'),
                is_default=addr_data.get('isDefault', False),
                address_type=addr_data.get('addressType', 'shipping')
            ))
        
        billing_addresses = []
        for addr_data in profile_data.get('billingAddresses', []):
            billing_addresses.append(Address(
                street=addr_data['street'],
                city=addr_data['city'],
                state=addr_data['state'],
                postal_code=addr_data['postalCode'],
                country=addr_data.get('country', 'US'),
                is_default=addr_data.get('isDefault', False),
                address_type=addr_data.get('addressType', 'billing')
            ))
        
        profile = CustomerProfile(
            first_name=profile_data.get('firstName', ''),
            last_name=profile_data.get('lastName', ''),
            phone=profile_data.get('phone'),
            shipping_addresses=shipping_addresses,
            billing_addresses=billing_addresses
        )
        
        preferences = CustomerPreferences(
            favorite_styles=preferences_data.get('favoriteStyles', []),
            price_range=preferences_data.get('priceRange', {'min': 0, 'max': 100000}),
            material_preferences=preferences_data.get('materialPreferences', []),
            newsletter_subscribed=preferences_data.get('newsletterSubscribed', False)
        )
        
        return cls(
            user_id=data['userId'],
            username=data.get('username', data['email']),
            email=data['email'],
            password_hash=data['passwordHash'],
            profile=profile,
            preferences=preferences,
            created_at=datetime.fromisoformat(data['createdAt']),
            last_login=datetime.fromisoformat(data['lastLogin']) if data.get('lastLogin') else None
        )


@dataclass
class CartItem:
    """Shopping cart item model"""
    cart_id: str
    user_id: str
    product_id: str
    name: str
    price: Decimal
    quantity: int
    added_at: datetime
    updated_at: datetime
    ttl: int
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert cart item to dictionary for DynamoDB storage"""
        return {
            'cartId': self.cart_id,
            'userId': self.user_id,
            'productId': self.product_id,
            'name': self.name,
            'price': self.price,
            'quantity': self.quantity,
            'addedAt': self.added_at.isoformat(),
            'updatedAt': self.updated_at.isoformat(),
            'ttl': self.ttl
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'CartItem':
        """Create cart item from DynamoDB data"""
        return cls(
            cart_id=data['cartId'],
            user_id=data['userId'],
            product_id=data['productId'],
            name=data.get('name', ''),
            price=Decimal(str(data.get('price', 0))),
            quantity=int(data.get('quantity', 0)),
            added_at=datetime.fromisoformat(data['addedAt']),
            updated_at=datetime.fromisoformat(data['updatedAt']),
            ttl=int(data.get('ttl', 0))
        )
    
    @property
    def total_price(self) -> Decimal:
        """Calculate total price for this cart item"""
        return self.price * self.quantity


@dataclass
class ShoppingCart:
    """Shopping cart model containing multiple items"""
    user_id: str
    items: List[CartItem] = field(default_factory=list)
    
    @property
    def total_amount(self) -> Decimal:
        """Calculate total amount for all items in cart"""
        return sum(item.total_price for item in self.items)
    
    @property
    def item_count(self) -> int:
        """Get total number of items in cart"""
        return len(self.items)
    
    @property
    def total_quantity(self) -> int:
        """Get total quantity of all items in cart"""
        return sum(item.quantity for item in self.items)
    
    def add_item(self, item: CartItem) -> None:
        """Add item to cart"""
        # Check if item already exists
        for existing_item in self.items:
            if existing_item.product_id == item.product_id:
                existing_item.quantity += item.quantity
                existing_item.updated_at = datetime.now()
                return
        
        # Add new item
        self.items.append(item)
    
    def remove_item(self, product_id: str) -> bool:
        """Remove item from cart by product ID"""
        for i, item in enumerate(self.items):
            if item.product_id == product_id:
                del self.items[i]
                return True
        return False
    
    def update_item_quantity(self, product_id: str, quantity: int) -> bool:
        """Update quantity of specific item"""
        for item in self.items:
            if item.product_id == product_id:
                if quantity <= 0:
                    return self.remove_item(product_id)
                item.quantity = quantity
                item.updated_at = datetime.now()
                return True
        return False
    
    def clear(self) -> None:
        """Clear all items from cart"""
        self.items.clear()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert shopping cart to dictionary"""
        return {
            'userId': self.user_id,
            'items': [item.to_dict() for item in self.items],
            'totalAmount': float(self.total_amount),
            'itemCount': self.item_count,
            'totalQuantity': self.total_quantity
        }


@dataclass
class Session:
    """User session model"""
    session_id: str
    user_id: str
    created_at: datetime
    ttl: int
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert session to dictionary for DynamoDB storage"""
        return {
            'sessionId': self.session_id,
            'userId': self.user_id,
            'createdAt': self.created_at.isoformat(),
            'ttl': self.ttl
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Session':
        """Create session from DynamoDB data"""
        return cls(
            session_id=data['sessionId'],
            user_id=data['userId'],
            created_at=datetime.fromisoformat(data['createdAt']),
            ttl=int(data['ttl'])
        )
    
    @property
    def is_expired(self) -> bool:
        """Check if session is expired"""
        return datetime.now().timestamp() > self.ttl


# Validation functions
def validate_email(email: str) -> bool:
    """Basic email validation"""
    import re
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return re.match(pattern, email) is not None


def validate_password(password: str) -> Dict[str, Any]:
    """Validate password strength"""
    errors = []
    
    if len(password) < 8:
        errors.append("Password must be at least 8 characters long")
    
    if not any(c.isupper() for c in password):
        errors.append("Password must contain at least one uppercase letter")
    
    if not any(c.islower() for c in password):
        errors.append("Password must contain at least one lowercase letter")
    
    if not any(c.isdigit() for c in password):
        errors.append("Password must contain at least one digit")
    
    return {
        'valid': len(errors) == 0,
        'errors': errors
    }


def validate_phone(phone: str) -> bool:
    """Basic phone number validation"""
    import re
    # Remove all non-digit characters
    digits_only = re.sub(r'\D', '', phone)
    # Check if it's a valid US phone number (10 or 11 digits)
    return len(digits_only) in [10, 11]


def validate_cart_item_data(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate cart item data"""
    errors = []
    
    if not data.get('productId'):
        errors.append("Product ID is required")
    
    try:
        quantity = int(data.get('quantity', 0))
        if quantity <= 0:
            errors.append("Quantity must be greater than 0")
    except (ValueError, TypeError):
        errors.append("Quantity must be a valid number")
    
    try:
        price = float(data.get('price', 0))
        if price < 0:
            errors.append("Price cannot be negative")
    except (ValueError, TypeError):
        errors.append("Price must be a valid number")
    
    return {
        'valid': len(errors) == 0,
        'errors': errors
    }