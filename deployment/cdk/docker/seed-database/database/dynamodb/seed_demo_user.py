#!/usr/bin/env python3
"""
Demo User Account Creation Service
Creates a demo user account in the User Auth service DynamoDB tables
"""

import os
import sys
import json
import uuid
import hashlib
import boto3
from datetime import datetime
from decimal import Decimal
from botocore.exceptions import ClientError, NoCredentialsError

# AWS Configuration
AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
PROJECT_NAME = os.getenv('PROJECT_NAME', 'shopsmart')
ENVIRONMENT = os.getenv('ENVIRONMENT', 'dev')

# Demo user configuration
DEMO_USER = {
    'username': 'demo',
    'email': 'demo@artisandesks.com',
    'password': 'demo',
    'name': 'Demo User',
    'firstName': 'Demo',
    'lastName': 'User',
    'phone': '+1-555-0123'
}

class DemoUserSeeder:
    def __init__(self):
        self.dynamodb = None
        self.user_table = None
        self.cart_table = None
        
    def initialize_aws_client(self):
        """Initialize AWS DynamoDB client"""
        try:
            # Initialize DynamoDB resource
            print(f"Using AWS region: {AWS_REGION}")
            self.dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
            
            # Get table names
            self.user_table_name = f"{PROJECT_NAME}-{ENVIRONMENT}-users"
            self.cart_table_name = f"{PROJECT_NAME}-{ENVIRONMENT}-carts"
            
            # Get table references
            self.user_table = self.dynamodb.Table(self.user_table_name)
            self.cart_table = self.dynamodb.Table(self.cart_table_name)
            
            print(f"✓ AWS DynamoDB client initialized")
            print(f"  User Table: {self.user_table_name}")
            print(f"  Cart Table: {self.cart_table_name}")
            
            return True
            
        except NoCredentialsError:
            print("✗ AWS credentials not found. Please configure AWS credentials.")
            print("  Run: aws configure")
            print("  Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables")
            return False
        except Exception as e:
            print(f"✗ Failed to initialize AWS client: {e}")
            return False
    
    def validate_tables_exist(self):
        """Validate that required DynamoDB tables exist"""
        try:
            # Check user table
            user_table_status = self.user_table.table_status
            print(f"✓ User table status: {user_table_status}")
            
            # Check cart table
            cart_table_status = self.cart_table.table_status
            print(f"✓ Cart table status: {cart_table_status}")
            
            if user_table_status != 'ACTIVE' or cart_table_status != 'ACTIVE':
                print("✗ Tables are not in ACTIVE state")
                return False
            
            return True
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            print(f"✗ ClientError: {error_code} - {e}")
            if error_code == 'ResourceNotFoundException':
                print("✗ Required DynamoDB tables not found")
                print("  Please deploy the CDK stack first to create the tables")
                print(f"  Looking for tables: {self.user_table_name}, {self.cart_table_name}")
            else:
                print(f"✗ Error accessing tables: {e}")
            return False
        except Exception as e:
            print(f"✗ Unexpected error validating tables: {e}")
            print(f"  Exception type: {type(e)}")
            print(f"  User table: {self.user_table_name}")
            print(f"  Cart table: {self.cart_table_name}")
            import traceback
            traceback.print_exc()
            return False
    
    def hash_password(self, password):
        """Hash password using SHA256 (matches Lambda function implementation)"""
        return hashlib.sha256(password.encode()).hexdigest()
    
    def check_existing_demo_user(self):
        """Check if demo user already exists"""
        try:
            # Query by email using GSI
            response = self.user_table.query(
                IndexName='EmailIndex',
                KeyConditionExpression='email = :email',
                ExpressionAttributeValues={':email': DEMO_USER['email']}
            )
            
            if response['Items']:
                existing_user = response['Items'][0]
                print(f"✓ Demo user already exists:")
                print(f"  User ID: {existing_user['userId']}")
                print(f"  Email: {existing_user['email']}")
                print(f"  Name: {existing_user.get('name', 'N/A')}")
                print(f"  Created: {existing_user.get('createdAt', 'N/A')}")
                return existing_user
            
            return None
            
        except Exception as e:
            print(f"✗ Error checking existing user: {e}")
            return None
    
    def create_demo_user(self):
        """Create demo user account"""
        try:
            # Generate user ID
            user_id = str(uuid.uuid4())
            
            # Hash password
            password_hash = self.hash_password(DEMO_USER['password'])
            
            # Create user profile
            user_profile = {
                'firstName': DEMO_USER['firstName'],
                'lastName': DEMO_USER['lastName'],
                'phone': DEMO_USER['phone'],
                'shippingAddresses': [],
                'billingAddresses': []
            }
            
            # Create user preferences
            user_preferences = {
                'favoriteStyles': ['Mid-Century Modern', 'Scandinavian', 'Contemporary'],
                'priceRange': {'min': 10000, 'max': 100000},
                'materialPreferences': ['Walnut Burl', 'Reclaimed Teak', 'Ebony'],
                'newsletterSubscribed': True
            }
            
            # Create user item
            user_item = {
                'userId': user_id,
                'email': DEMO_USER['email'],
                'name': DEMO_USER['name'],
                'passwordHash': password_hash,
                'profile': user_profile,
                'preferences': user_preferences,
                'createdAt': datetime.now().isoformat(),
                'lastLogin': None,
                'accountType': 'demo'
            }
            
            # Insert user into DynamoDB
            self.user_table.put_item(
                Item=user_item,
                ConditionExpression='attribute_not_exists(userId)'
            )
            
            print(f"✓ Demo user created successfully:")
            print(f"  User ID: {user_id}")
            print(f"  Email: {DEMO_USER['email']}")
            print(f"  Username: {DEMO_USER['username']}")
            print(f"  Password: {DEMO_USER['password']}")
            print(f"  Name: {DEMO_USER['name']}")
            
            return user_item
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'ConditionalCheckFailedException':
                print("✗ Demo user already exists (conditional check failed)")
            else:
                print(f"✗ Error creating demo user: {e}")
            return None
        except Exception as e:
            print(f"✗ Unexpected error creating demo user: {e}")
            return None
    
    def create_demo_cart_items(self, user_id):
        """Create some sample cart items for the demo user"""
        try:
            # Sample cart items (these would reference actual product IDs in a real scenario)
            sample_items = [
                {
                    'productId': 'sample-desk-1',
                    'name': 'The Executive Summit - Walnut Burl Mid-Century Modern',
                    'price': 25000.00,
                    'quantity': 1
                },
                {
                    'productId': 'sample-desk-2', 
                    'name': 'Zen Master\'s Retreat - Ebony Japanese Minimalist',
                    'price': 45000.00,
                    'quantity': 1
                }
            ]
            
            created_items = []
            
            for item in sample_items:
                cart_id = f"{user_id}#{item['productId']}"
                
                cart_item = {
                    'cartId': cart_id,
                    'userId': user_id,
                    'productId': item['productId'],
                    'name': item['name'],
                    'price': Decimal(str(item['price'])),
                    'quantity': item['quantity'],
                    'addedAt': datetime.now().isoformat(),
                    'updatedAt': datetime.now().isoformat(),
                    # TTL set to 30 days from now (as per Lambda function)
                    'ttl': int((datetime.now().timestamp()) + (30 * 24 * 60 * 60))
                }
                
                self.cart_table.put_item(Item=cart_item)
                created_items.append(cart_item)
            
            print(f"✓ Created {len(created_items)} sample cart items for demo user")
            for item in created_items:
                print(f"  - {item['name']} (${item['price']:,})")
            
            return created_items
            
        except Exception as e:
            print(f"✗ Error creating demo cart items: {e}")
            return []
    
    def save_demo_user_report(self, user_data, cart_items):
        """Save demo user creation report"""
        try:
            report = {
                'creation_date': datetime.now().isoformat(),
                'user': {
                    'userId': user_data['userId'],
                    'email': user_data['email'],
                    'name': user_data['name'],
                    'username': DEMO_USER['username'],
                    'password': DEMO_USER['password']
                },
                'cart_items': [
                    {
                        'productId': item['productId'],
                        'name': item['name'],
                        'price': float(item['price']),
                        'quantity': item['quantity']
                    }
                    for item in cart_items
                ],
                'login_instructions': {
                    'endpoint': 'POST /auth/login',
                    'payload': {
                        'email': DEMO_USER['email'],
                        'password': DEMO_USER['password']
                    }
                }
            }
            
            report_file = f"database/dynamodb/demo_user_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            
            with open(report_file, 'w') as f:
                json.dump(report, f, indent=2)
            
            print(f"✓ Demo user report saved to {report_file}")
            
        except Exception as e:
            print(f"✗ Failed to save demo user report: {e}")
    
    def verify_demo_user_creation(self, user_id):
        """Verify demo user was created correctly"""
        try:
            # Get user by ID
            user_response = self.user_table.get_item(Key={'userId': user_id})
            
            if 'Item' not in user_response:
                print("✗ Demo user verification failed - user not found")
                return False
            
            user = user_response['Item']
            
            # Get cart items
            cart_response = self.cart_table.query(
                IndexName='UserIdIndex',
                KeyConditionExpression='userId = :userId',
                ExpressionAttributeValues={':userId': user_id}
            )
            
            cart_items = cart_response['Items']
            
            print(f"\n✓ Demo User Verification Results:")
            print(f"  User ID: {user['userId']}")
            print(f"  Email: {user['email']}")
            print(f"  Name: {user['name']}")
            print(f"  Account Type: {user.get('accountType', 'standard')}")
            print(f"  Cart Items: {len(cart_items)}")
            print(f"  Profile Complete: {'profile' in user}")
            print(f"  Preferences Set: {'preferences' in user}")
            
            return True
            
        except Exception as e:
            print(f"✗ Demo user verification failed: {e}")
            return False

def main():
    """Main demo user creation process"""
    print("👤 Demo User Account Creation Service")
    print("=" * 50)
    
    seeder = DemoUserSeeder()
    
    try:
        # Initialize AWS client
        if not seeder.initialize_aws_client():
            sys.exit(1)
        
        # Validate tables exist
        if not seeder.validate_tables_exist():
            sys.exit(1)
        
        # Check if demo user already exists
        existing_user = seeder.check_existing_demo_user()
        
        if existing_user and '--force' not in sys.argv:
            print("\n⚠️  Demo user already exists. Use --force to recreate.")
            
            # Verify existing user
            if seeder.verify_demo_user_creation(existing_user['userId']):
                print("\n✅ Existing demo user is valid and ready to use!")
                print(f"\nLogin credentials:")
                print(f"  Email: {DEMO_USER['email']}")
                print(f"  Password: {DEMO_USER['password']}")
            
            sys.exit(0)
        
        # Create demo user
        if existing_user and '--force' in sys.argv:
            print("🔄 Recreating demo user (--force flag used)")
        
        user_data = seeder.create_demo_user()
        if not user_data:
            sys.exit(1)
        
        # Create sample cart items
        cart_items = seeder.create_demo_cart_items(user_data['userId'])
        
        # Save report
        seeder.save_demo_user_report(user_data, cart_items)
        
        # Verify creation
        if seeder.verify_demo_user_creation(user_data['userId']):
            print("\n🎉 Demo user creation completed successfully!")
            print(f"\nLogin credentials:")
            print(f"  Email: {DEMO_USER['email']}")
            print(f"  Password: {DEMO_USER['password']}")
        else:
            print("\n⚠️  Demo user created but verification failed")
            sys.exit(1)
    
    except KeyboardInterrupt:
        print("\n\n⚠️  Demo user creation interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()