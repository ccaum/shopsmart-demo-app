"""
User Authentication Service
Enhanced with customer profiles and shopping cart management
"""

import os
import json
import hashlib
import uuid
import boto3
from datetime import datetime, timedelta
from decimal import Decimal
from flask import Flask, request, jsonify
from flask_cors import CORS
from botocore.exceptions import ClientError
import logging

# OpenTelemetry imports
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.botocore import BotocoreInstrumentor
from opentelemetry.sdk.resources import Resource

# Import custom modules
from models import Customer, CustomerProfile, CustomerPreferences, ShoppingCart, CartItem
from middleware.logging_middleware import setup_logging
from middleware.metrics_middleware import setup_metrics

# Configure OpenTelemetry with Dynatrace
def configure_dynatrace_tracing():
    """Configure OpenTelemetry with Dynatrace endpoint from SSM"""
    
    ssm_client = boto3.client('ssm')
    
    endpoint_param = os.getenv('OTEL_EXPORTER_OTLP_ENDPOINT_PARAM')
    token_param = os.getenv('OTEL_EXPORTER_OTLP_TOKEN_PARAM')
    
    if not endpoint_param or not token_param:
        dynatrace_endpoint = os.getenv('DYNATRACE_ENDPOINT')
        dynatrace_token = os.getenv('DYNATRACE_API_TOKEN')
        
        if not dynatrace_endpoint or not dynatrace_token:
            logging.warning("OpenTelemetry configuration not available - tracing disabled")
            return trace.get_tracer(__name__)
    else:
        try:
            endpoint_response = ssm_client.get_parameter(Name=endpoint_param)
            dynatrace_endpoint = endpoint_response['Parameter']['Value']
            
            token_response = ssm_client.get_parameter(Name=token_param)
            dynatrace_token = token_response['Parameter']['Value']
        except Exception as e:
            logging.error(f"Failed to retrieve OpenTelemetry configuration from SSM: {e}")
            dynatrace_endpoint = os.getenv('DYNATRACE_ENDPOINT')
            dynatrace_token = os.getenv('DYNATRACE_API_TOKEN')
            
            if not dynatrace_endpoint or not dynatrace_token:
                logging.warning("OpenTelemetry configuration not available - tracing disabled")
                return trace.get_tracer(__name__)
    
    service_name = os.getenv('OTEL_SERVICE_NAME', 'user-auth-service')
    service_version = os.getenv('OTEL_SERVICE_VERSION', '1.0.0')
    environment = os.getenv('DEPLOYMENT_ENVIRONMENT', 'production')
    
    resource = Resource.create({
        "service.name": service_name,
        "service.version": service_version,
        "deployment.environment": environment,
        "service.instance.id": os.getenv('HOSTNAME', 'unknown'),
    })
    
    trace.set_tracer_provider(TracerProvider(resource=resource))
    tracer_provider = trace.get_tracer_provider()
    
    otlp_exporter = OTLPSpanExporter(
        endpoint=f"{dynatrace_endpoint}/api/v2/otlp/v1/traces",
        headers={
            "Authorization": f"Api-Token {dynatrace_token}"
        }
    )
    
    span_processor = BatchSpanProcessor(otlp_exporter)
    tracer_provider.add_span_processor(span_processor)
    
    return trace.get_tracer(__name__)

# Initialize tracer
tracer = configure_dynatrace_tracing()

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Auto-instrument Flask and AWS services
FlaskInstrumentor().instrument_app(app)
BotocoreInstrumentor().instrument()

# Setup logging and metrics
setup_logging(app)
setup_metrics(app)

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

# DynamoDB table names from environment
USER_TABLE_NAME = os.environ.get('USER_TABLE_NAME', 'shopsmart-dev-users')
SESSION_TABLE_NAME = os.environ.get('SESSION_TABLE_NAME', 'shopsmart-dev-sessions')
CART_TABLE_NAME = os.environ.get('CART_TABLE_NAME', 'shopsmart-dev-carts')

# Initialize tables
user_table = dynamodb.Table(USER_TABLE_NAME)
session_table = dynamodb.Table(SESSION_TABLE_NAME)
cart_table = dynamodb.Table(CART_TABLE_NAME)

logger = logging.getLogger(__name__)


def hash_password(password: str) -> str:
    """Hash password using SHA256 (in production, use bcrypt or similar)"""
    return hashlib.sha256(password.encode()).hexdigest()


def create_session(user_id: str) -> dict:
    """Create a new session for user"""
    session_id = str(uuid.uuid4())
    ttl = int((datetime.now() + timedelta(hours=24)).timestamp())
    
    session_data = {
        'sessionId': session_id,
        'userId': user_id,
        'ttl': ttl,
        'createdAt': datetime.now().isoformat()
    }
    
    session_table.put_item(Item=session_data)
    return {'sessionId': session_id, 'ttl': ttl}


def validate_session(session_id: str) -> dict:
    """Validate session and return user info"""
    try:
        response = session_table.get_item(Key={'sessionId': session_id})
        if 'Item' not in response:
            return None
        
        session = response['Item']
        
        # Get user details
        user_response = user_table.get_item(Key={'userId': session['userId']})
        if 'Item' not in user_response:
            return None
        
        return user_response['Item']
    except ClientError as e:
        logger.error(f"Session validation error: {e}")
        return None


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint with dependency verification"""
    try:
        health_status = {
            'status': 'healthy',
            'service': 'user-auth',
            'version': '1.0.0',
            'timestamp': datetime.now().isoformat(),
            'dependencies': {}
        }
        
        # Check DynamoDB connectivity
        try:
            # Test user table connectivity
            user_table.describe_table()
            health_status['dependencies']['user_table'] = 'connected'
            
            # Test session table connectivity  
            session_table.describe_table()
            health_status['dependencies']['session_table'] = 'connected'
            
            # Test cart table connectivity
            cart_table.describe_table()
            health_status['dependencies']['cart_table'] = 'connected'
            
            health_status['dependencies']['dynamodb'] = 'connected'
            
        except ClientError as e:
            logger.error(f"DynamoDB health check failed: {e}")
            health_status['status'] = 'unhealthy'
            health_status['dependencies']['dynamodb'] = f'error: {str(e)}'
            health_status['error'] = 'DynamoDB connectivity failed'
            return jsonify(health_status), 503
        except Exception as e:
            logger.error(f"Unexpected error in DynamoDB health check: {e}")
            health_status['status'] = 'unhealthy'
            health_status['dependencies']['dynamodb'] = f'error: {str(e)}'
            health_status['error'] = 'Unexpected error checking DynamoDB'
            return jsonify(health_status), 503
        
        # Check environment configuration
        required_env_vars = ['USER_TABLE_NAME', 'SESSION_TABLE_NAME', 'CART_TABLE_NAME']
        missing_env_vars = [var for var in required_env_vars if not os.environ.get(var)]
        
        if missing_env_vars:
            health_status['status'] = 'degraded'
            health_status['dependencies']['environment'] = f'missing: {", ".join(missing_env_vars)}'
            health_status['warning'] = f'Missing environment variables: {", ".join(missing_env_vars)}'
        else:
            health_status['dependencies']['environment'] = 'configured'
        
        # Return appropriate status code
        status_code = 200 if health_status['status'] == 'healthy' else 503
        return jsonify(health_status), status_code
        
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({
            'status': 'unhealthy',
            'service': 'user-auth',
            'timestamp': datetime.now().isoformat(),
            'error': str(e),
            'dependencies': {}
        }), 503


@app.route('/auth/register', methods=['POST'])
def register():
    """Register new customer account"""
    with tracer.start_as_current_span("auth.register") as span:
        try:
            data = request.get_json()
            
            # Validate required fields
            required_fields = ['email', 'password', 'firstName', 'lastName']
            for field in required_fields:
                if not data.get(field):
                    return jsonify({'error': f'{field} is required'}), 400
            
            email = data['email'].lower().strip()
            password = data['password']
            
            span.set_attribute("user.email", email)
            span.set_attribute("user.has_phone", bool(data.get('phone')))
            
            # Check if user already exists
            try:
                response = user_table.query(
                    IndexName='EmailIndex',
                    KeyConditionExpression='email = :email',
                    ExpressionAttributeValues={':email': email}
                )
                
                if response['Items']:
                    span.set_attribute("registration.status", "duplicate")
                    return jsonify({'error': 'User already exists'}), 409
            except ClientError as e:
                logger.error(f"Email lookup error: {e}")
                span.set_attribute("error", True)
                span.set_attribute("error.type", "email_lookup_failed")
                return jsonify({'error': 'Registration failed'}), 500
            
            # Create customer profile
            profile = CustomerProfile(
                first_name=data['firstName'],
                last_name=data['lastName'],
                phone=data.get('phone'),
                shipping_addresses=[],
                billing_addresses=[]
            )
            
            # Create customer preferences
            preferences = CustomerPreferences(
                favorite_styles=data.get('favoriteStyles', []),
                price_range=data.get('priceRange', {'min': 0, 'max': 100000}),
                material_preferences=data.get('materialPreferences', []),
                newsletter_subscribed=data.get('newsletterSubscribed', False)
            )
            
            # Create customer
            user_id = str(uuid.uuid4())
            span.set_attribute("user.id", user_id)
            customer = Customer(
                user_id=user_id,
                username=data.get('username', email),
                email=email,
            password_hash=hash_password(password),
            profile=profile,
            preferences=preferences,
            created_at=datetime.now(),
            last_login=None
        )
        
        # Save to DynamoDB
        user_item = {
            'userId': customer.user_id,
            'username': customer.username,
            'email': customer.email,
            'passwordHash': customer.password_hash,
            'profile': {
                'firstName': customer.profile.first_name,
                'lastName': customer.profile.last_name,
                'phone': customer.profile.phone,
                'shippingAddresses': customer.profile.shipping_addresses,
                'billingAddresses': customer.profile.billing_addresses
            },
            'preferences': {
                'favoriteStyles': customer.preferences.favorite_styles,
                'priceRange': customer.preferences.price_range,
                'materialPreferences': customer.preferences.material_preferences,
                'newsletterSubscribed': customer.preferences.newsletter_subscribed
            },
            'createdAt': customer.created_at.isoformat(),
            'lastLogin': None
        }
        
        user_table.put_item(Item=user_item)
        
        logger.info(f"User registered successfully: {user_id}")
        span.set_attribute("registration.status", "success")
        
        return jsonify({
            'userId': user_id,
            'email': email,
            'username': customer.username,
            'profile': {
                'firstName': customer.profile.first_name,
                'lastName': customer.profile.last_name
            }
        }), 201
        
        except Exception as e:
            logger.error(f"Registration error: {e}")
            span.set_attribute("error", True)
            span.set_attribute("error.type", str(type(e).__name__))
            return jsonify({'error': 'Registration failed'}), 500


@app.route('/auth/login', methods=['POST'])
def login():
    """Authenticate user and create session"""
    with tracer.start_as_current_span("auth.login") as span:
        try:
            data = request.get_json()
            
            email = data.get('email', '').lower().strip()
            password = data.get('password', '')
            
            span.set_attribute("user.email", email)
            
            if not email or not password:
                span.set_attribute("login.status", "missing_credentials")
                return jsonify({'error': 'Email and password are required'}), 400
            
            # Look up user by email
            response = user_table.query(
                IndexName='EmailIndex',
                KeyConditionExpression='email = :email',
                ExpressionAttributeValues={':email': email}
            )
            
            if not response['Items']:
                span.set_attribute("login.status", "invalid_credentials")
                return jsonify({'error': 'Invalid credentials'}), 401
            
            user = response['Items'][0]
            span.set_attribute("user.id", user['userId'])
        
        # Verify password
        if user['passwordHash'] != hash_password(password):
            span.set_attribute("login.status", "invalid_password")
            return jsonify({'error': 'Invalid credentials'}), 401
        
        # Update last login
        user_table.update_item(
            Key={'userId': user['userId']},
            UpdateExpression='SET lastLogin = :lastLogin',
            ExpressionAttributeValues={':lastLogin': datetime.now().isoformat()}
        )
        
        # Create session
        session_info = create_session(user['userId'])
        span.set_attribute("session.id", session_info['sessionId'])
        span.set_attribute("login.status", "success")
        
        logger.info(f"User logged in successfully: {user['userId']}")
        
        return jsonify({
            'sessionId': session_info['sessionId'],
            'userId': user['userId'],
            'email': user['email'],
            'username': user.get('username', user['email']),
            'profile': user.get('profile', {})
        }), 200
        
        except Exception as e:
            logger.error(f"Login error: {e}")
            span.set_attribute("error", True)
            span.set_attribute("error.type", str(type(e).__name__))
            return jsonify({'error': 'Login failed'}), 500


@app.route('/auth/validate/<session_id>', methods=['GET'])
def validate_session_endpoint(session_id):
    """Validate session and return user info"""
    try:
        user = validate_session(session_id)
        if not user:
            return jsonify({'error': 'Invalid session'}), 401
        
        return jsonify({
            'userId': user['userId'],
            'email': user['email'],
            'username': user.get('username', user['email']),
            'profile': user.get('profile', {}),
            'sessionId': session_id
        }), 200
        
    except Exception as e:
        logger.error(f"Session validation error: {e}")
        return jsonify({'error': 'Session validation failed'}), 500


@app.route('/auth/profile/<user_id>', methods=['GET'])
def get_profile(user_id):
    """Get user profile"""
    try:
        response = user_table.get_item(Key={'userId': user_id})
        if 'Item' not in response:
            return jsonify({'error': 'User not found'}), 404
        
        user = response['Item']
        
        return jsonify({
            'userId': user['userId'],
            'email': user['email'],
            'username': user.get('username', user['email']),
            'profile': user.get('profile', {}),
            'preferences': user.get('preferences', {}),
            'createdAt': user.get('createdAt'),
            'lastLogin': user.get('lastLogin')
        }), 200
        
    except Exception as e:
        logger.error(f"Get profile error: {e}")
        return jsonify({'error': 'Failed to get profile'}), 500


@app.route('/auth/profile/<user_id>', methods=['PUT'])
def update_profile(user_id):
    """Update user profile"""
    try:
        data = request.get_json()
        
        # Build update expression
        update_expression = "SET updatedAt = :updatedAt"
        expression_values = {':updatedAt': datetime.now().isoformat()}
        
        if 'profile' in data:
            update_expression += ", profile = :profile"
            expression_values[':profile'] = data['profile']
        
        if 'preferences' in data:
            update_expression += ", preferences = :preferences"
            expression_values[':preferences'] = data['preferences']
        
        # Update user
        user_table.update_item(
            Key={'userId': user_id},
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_values,
            ConditionExpression='attribute_exists(userId)'
        )
        
        logger.info(f"Profile updated successfully: {user_id}")
        
        return jsonify({'message': 'Profile updated successfully'}), 200
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return jsonify({'error': 'User not found'}), 404
        logger.error(f"Update profile error: {e}")
        return jsonify({'error': 'Failed to update profile'}), 500
    except Exception as e:
        logger.error(f"Update profile error: {e}")
        return jsonify({'error': 'Failed to update profile'}), 500


@app.route('/auth/cart/<user_id>', methods=['GET'])
def get_cart(user_id):
    """Get user's shopping cart"""
    try:
        # Query cart items for user
        response = cart_table.query(
            IndexName='UserIdIndex',
            KeyConditionExpression='userId = :userId',
            ExpressionAttributeValues={':userId': user_id}
        )
        
        cart_items = []
        total_amount = Decimal('0')
        
        for item in response['Items']:
            cart_item = {
                'cartId': item['cartId'],
                'productId': item['productId'],
                'name': item.get('name', ''),
                'price': float(item.get('price', 0)),
                'quantity': int(item.get('quantity', 0)),
                'addedAt': item.get('addedAt'),
                'updatedAt': item.get('updatedAt')
            }
            cart_items.append(cart_item)
            total_amount += Decimal(str(cart_item['price'])) * cart_item['quantity']
        
        return jsonify({
            'items': cart_items,
            'totalAmount': float(total_amount),
            'itemCount': len(cart_items)
        }), 200
        
    except Exception as e:
        logger.error(f"Get cart error: {e}")
        return jsonify({'error': 'Failed to get cart'}), 500


@app.route('/auth/cart/<user_id>', methods=['PUT'])
def update_cart(user_id):
    """Update shopping cart contents"""
    with tracer.start_as_current_span("cart.update") as span:
        try:
            data = request.get_json()
            
            product_id = data.get('productId')
            quantity = int(data.get('quantity', 1))
            price = Decimal(str(data.get('price', 0)))
            name = data.get('name', '')
            
            span.set_attribute("user.id", user_id)
            span.set_attribute("cart.product_id", product_id)
            span.set_attribute("cart.quantity", quantity)
            
            if not product_id or quantity <= 0:
                span.set_attribute("cart.status", "invalid_input")
                return jsonify({'error': 'Product ID and valid quantity are required'}), 400
            
            # Create cart item ID
            cart_id = f"{user_id}#{product_id}"
            
            # Set TTL for 30 days from now
            ttl = int((datetime.now() + timedelta(days=30)).timestamp())
            
            # Check if item already exists in cart
            try:
                response = cart_table.get_item(Key={'cartId': cart_id})
                if 'Item' in response:
                    # Update existing item quantity
                    existing_quantity = int(response['Item']['quantity'])
                    new_quantity = existing_quantity + quantity
                    span.set_attribute("cart.action", "update_existing")
                    span.set_attribute("cart.new_quantity", new_quantity)
                    
                    cart_table.update_item(
                        Key={'cartId': cart_id},
                        UpdateExpression='SET quantity = :quantity, updatedAt = :updatedAt, #ttl = :ttl',
                        ExpressionAttributeNames={'#ttl': 'ttl'},
                    ExpressionAttributeValues={
                        ':quantity': new_quantity,
                        ':updatedAt': datetime.now().isoformat(),
                        ':ttl': ttl
                    }
                )
                
                logger.info(f"Cart item quantity updated: {cart_id}")
                span.set_attribute("cart.status", "success")
                
                return jsonify({
                    'message': 'Item quantity updated in cart',
                    'cartId': cart_id,
                    'quantity': new_quantity
                }), 200
            else:
                # Add new item to cart
                span.set_attribute("cart.action", "add_new")
                cart_table.put_item(
                    Item={
                        'cartId': cart_id,
                        'userId': user_id,
                        'productId': product_id,
                        'name': name,
                        'price': price,
                        'quantity': quantity,
                        'addedAt': datetime.now().isoformat(),
                        'updatedAt': datetime.now().isoformat(),
                        'ttl': ttl
                    }
                )
                
                logger.info(f"Item added to cart: {cart_id}")
                span.set_attribute("cart.status", "success")
                
                return jsonify({
                    'message': 'Item added to cart',
                    'cartId': cart_id,
                    'quantity': quantity
                }), 201
                
            except Exception as e:
                logger.error(f"DynamoDB Error: {e}")
                span.set_attribute("error", True)
                span.set_attribute("error.type", str(type(e).__name__))
                raise e
        
        except Exception as e:
            logger.error(f"Update cart error: {e}")
            span.set_attribute("error", True)
            span.set_attribute("error.type", str(type(e).__name__))
            return jsonify({'error': 'Failed to update cart'}), 500


@app.route('/auth/cart/<user_id>/<product_id>', methods=['PUT'])
def update_cart_item(user_id, product_id):
    """Update specific cart item quantity"""
    try:
        data = request.get_json()
        quantity = int(data.get('quantity', 1))
        
        if quantity <= 0:
            return jsonify({'error': 'Quantity must be greater than 0'}), 400
        
        cart_id = f"{user_id}#{product_id}"
        
        # Update TTL for 30 days from now
        ttl = int((datetime.now() + timedelta(days=30)).timestamp())
        
        # Update item quantity
        cart_table.update_item(
            Key={'cartId': cart_id},
            UpdateExpression='SET quantity = :quantity, updatedAt = :updatedAt, #ttl = :ttl',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':quantity': quantity,
                ':updatedAt': datetime.now().isoformat(),
                ':ttl': ttl
            },
            ConditionExpression='attribute_exists(cartId)'
        )
        
        logger.info(f"Cart item updated: {cart_id}")
        
        return jsonify({
            'message': 'Cart item updated',
            'cartId': cart_id,
            'quantity': quantity
        }), 200
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return jsonify({'error': 'Cart item not found'}), 404
        logger.error(f"Update cart item error: {e}")
        return jsonify({'error': 'Failed to update cart item'}), 500
    except Exception as e:
        logger.error(f"Update cart item error: {e}")
        return jsonify({'error': 'Failed to update cart item'}), 500


@app.route('/auth/cart/<user_id>/<product_id>', methods=['DELETE'])
def remove_cart_item(user_id, product_id):
    """Remove item from cart"""
    try:
        cart_id = f"{user_id}#{product_id}"
        
        # Delete item from cart
        cart_table.delete_item(
            Key={'cartId': cart_id},
            ConditionExpression='attribute_exists(cartId)'
        )
        
        logger.info(f"Item removed from cart: {cart_id}")
        
        return jsonify({
            'message': 'Item removed from cart',
            'cartId': cart_id
        }), 200
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return jsonify({'error': 'Cart item not found'}), 404
        logger.error(f"Remove cart item error: {e}")
        return jsonify({'error': 'Failed to remove cart item'}), 500
    except Exception as e:
        logger.error(f"Remove cart item error: {e}")
        return jsonify({'error': 'Failed to remove cart item'}), 500


@app.route('/auth/cart/<user_id>', methods=['DELETE'])
def clear_cart(user_id):
    """Clear all items from user's cart"""
    try:
        # Query all cart items for user
        response = cart_table.query(
            IndexName='UserIdIndex',
            KeyConditionExpression='userId = :userId',
            ExpressionAttributeValues={':userId': user_id}
        )
        
        cart_items = response['Items']
        
        # Delete all items
        deleted_count = 0
        with cart_table.batch_writer() as batch:
            for item in cart_items:
                batch.delete_item(Key={'cartId': item['cartId']})
                deleted_count += 1
        
        logger.info(f"Cart cleared for user: {user_id}, deleted {deleted_count} items")
        
        return jsonify({
            'message': 'Cart cleared',
            'deletedItems': deleted_count
        }), 200
        
    except Exception as e:
        logger.error(f"Clear cart error: {e}")
        return jsonify({'error': 'Failed to clear cart'}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8002))
    debug = os.environ.get('DEBUG', 'False').lower() == 'true'
    app.run(host='0.0.0.0', port=port, debug=debug)