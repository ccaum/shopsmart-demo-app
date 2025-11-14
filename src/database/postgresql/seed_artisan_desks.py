#!/usr/bin/env python3
"""
Artisan Desk Product Seeding Service
Generates 50 unique artisanal desk products with realistic luxury data
"""

import os
import sys
import random
import uuid
from decimal import Decimal
from datetime import datetime, timedelta
import psycopg2
from psycopg2.extras import RealDictCursor
import json

# Database configuration
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432'),
    'database': os.getenv('DB_NAME', 'shopsmart_catalog'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password')
}

# Artisan desk data for realistic generation
MATERIALS = [
    'Reclaimed Teak', 'Walnut Burl', 'Ebony', 'Rosewood', 'Mahogany',
    'Zebrawood', 'Purpleheart', 'Padauk', 'Wenge', 'Bocote',
    'Figured Maple', 'Cherry Burl', 'Olive Wood', 'Cocobolo', 'Bubinga',
    'Bloodwood', 'Spalted Beech', 'Amboyna Burl', 'Koa', 'Lignum Vitae'
]

STYLES = [
    'Mid-Century Modern', 'Scandinavian', 'Industrial', 'Art Deco', 'Bauhaus',
    'Japanese Minimalist', 'Victorian', 'Craftsman', 'Contemporary', 'Rustic',
    'Steampunk', 'Brutalist', 'Organic Modern', 'Neo-Classical', 'Avant-Garde'
]

ARTISAN_NAMES = [
    'Alessandro Mendini', 'Hiroshi Nakamura', 'Elena Volkov', 'Marcus Thornfield',
    'Yuki Tanaka', 'Isabella Romano', 'Dmitri Petrov', 'Sophia Chen',
    'Giovanni Rosetti', 'Akira Yamamoto', 'Francesca Bianchi', 'Viktor Kozlov',
    'Mei-Lin Wu', 'Leonardo Conti', 'Anastasia Volkov', 'Kenji Nakamura',
    'Valentina Rossi', 'Mikhail Petrov', 'Sakura Tanaka', 'Matteo Bianchi',
    'Natasha Kozlov', 'Hiroto Yamamoto', 'Giulia Romano', 'Alexei Volkov',
    'Yuki Nakamura', 'Francesca Conti', 'Dmitri Kozlov', 'Isabella Chen',
    'Giovanni Petrov', 'Sophia Tanaka', 'Alessandro Romano', 'Elena Nakamura',
    'Marcus Volkov', 'Yuki Rossi', 'Hiroshi Chen', 'Valentina Petrov',
    'Leonardo Kozlov', 'Anastasia Tanaka', 'Kenji Romano', 'Matteo Nakamura',
    'Natasha Volkov', 'Hiroto Chen', 'Giulia Petrov', 'Alexei Tanaka',
    'Sakura Romano', 'Francesca Nakamura', 'Dmitri Volkov', 'Isabella Rossi',
    'Giovanni Chen', 'Sophia Petrov'
]

DESK_NAMES = [
    'The Executive Summit', 'Zen Master\'s Retreat', 'Industrial Titan',
    'Art Nouveau Masterpiece', 'Minimalist Sanctuary', 'Victorian Grandeur',
    'Craftsman\'s Pride', 'Contemporary Vision', 'Rustic Heritage',
    'Steampunk Commander', 'Brutalist Monument', 'Organic Flow',
    'Neo-Classical Elegance', 'Avant-Garde Statement', 'Emperor\'s Throne',
    'Philosopher\'s Study', 'Artist\'s Canvas', 'Scholar\'s Haven',
    'Mogul\'s Empire', 'Creator\'s Workshop', 'Visionary\'s Platform',
    'Innovator\'s Lab', 'Maestro\'s Studio', 'Pioneer\'s Base',
    'Legend\'s Legacy', 'Master\'s Domain', 'Genius\'s Workspace',
    'Titan\'s Command', 'Oracle\'s Wisdom', 'Champion\'s Victory',
    'Sovereign\'s Decree', 'Virtuoso\'s Performance', 'Luminary\'s Brilliance',
    'Patriarch\'s Authority', 'Sage\'s Contemplation', 'Prodigy\'s Innovation',
    'Magnate\'s Empire', 'Savant\'s Discovery', 'Connoisseur\'s Choice',
    'Aristocrat\'s Privilege', 'Maverick\'s Revolution', 'Curator\'s Collection',
    'Dignitary\'s Presence', 'Perfectionist\'s Standard', 'Visionary\'s Dream',
    'Artisan\'s Masterwork', 'Collector\'s Prize', 'Designer\'s Signature',
    'Craftsman\'s Legacy', 'Master\'s Opus'
]

DESCRIPTIONS = [
    "Handcrafted with meticulous attention to detail, this extraordinary piece represents the pinnacle of artisanal furniture making.",
    "A testament to traditional craftsmanship merged with contemporary design sensibilities, creating an heirloom for generations.",
    "Featuring intricate joinery and hand-selected premium materials, this desk embodies luxury and functionality in perfect harmony.",
    "Each curve and line has been carefully sculpted by master artisans, resulting in a piece that transcends mere furniture.",
    "This exceptional creation showcases the finest woodworking techniques passed down through generations of skilled craftspeople.",
    "A unique fusion of artistic vision and practical design, handcrafted using time-honored methods and premium materials.",
    "Representing months of dedicated craftsmanship, this piece features hand-carved details and museum-quality finishing.",
    "An extraordinary example of artisanal excellence, combining rare materials with innovative design concepts.",
    "Meticulously crafted using traditional techniques, this desk represents the ultimate expression of luxury workspace furniture.",
    "A masterpiece of functional art, featuring hand-selected materials and custom hardware crafted by renowned artisans."
]

class ArtisanDeskSeeder:
    def __init__(self):
        self.connection = None
        self.cursor = None
        
    def connect_database(self):
        """Establish database connection"""
        try:
            self.connection = psycopg2.connect(**DB_CONFIG)
            self.cursor = self.connection.cursor(cursor_factory=RealDictCursor)
            print("✓ Database connection established")
            return True
        except Exception as e:
            print(f"✗ Database connection failed: {e}")
            return False
    
    def disconnect_database(self):
        """Close database connection"""
        if self.cursor:
            self.cursor.close()
        if self.connection:
            self.connection.close()
        print("✓ Database connection closed")
    
    def validate_schema(self):
        """Validate that the artisan desk columns exist"""
        try:
            self.cursor.execute("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'products' 
                AND column_name IN ('material', 'style', 'crafting_time_months', 'artisan_name', 'authenticity_certificate')
            """)
            columns = [row['column_name'] for row in self.cursor.fetchall()]
            
            required_columns = ['material', 'style', 'crafting_time_months', 'artisan_name', 'authenticity_certificate']
            missing_columns = [col for col in required_columns if col not in columns]
            
            if missing_columns:
                print(f"✗ Missing required columns: {missing_columns}")
                print("Please run the database migration first: ./migrate.sh up")
                return False
            
            print("✓ Database schema validation passed")
            return True
        except Exception as e:
            print(f"✗ Schema validation failed: {e}")
            return False
    
    def clear_existing_artisan_desks(self):
        """Remove existing artisan desk products"""
        try:
            self.cursor.execute("""
                DELETE FROM products 
                WHERE category = 'Artisanal Desks' 
                AND material IS NOT NULL 
                AND artisan_name IS NOT NULL
            """)
            deleted_count = self.cursor.rowcount
            self.connection.commit()
            print(f"✓ Cleared {deleted_count} existing artisan desk products")
            return True
        except Exception as e:
            print(f"✗ Failed to clear existing products: {e}")
            self.connection.rollback()
            return False
    
    def generate_artisan_desk_data(self, index):
        """Generate realistic artisan desk product data"""
        # Ensure unique combinations
        material = random.choice(MATERIALS)
        style = random.choice(STYLES)
        artisan = random.choice(ARTISAN_NAMES)
        
        # Create unique name by combining elements
        base_name = random.choice(DESK_NAMES)
        name = f"{base_name} - {material} {style}"
        
        # Generate exorbitant pricing between $5,000 and $500,000
        price_ranges = [
            (5000, 15000),    # Entry luxury
            (15000, 50000),   # Mid luxury  
            (50000, 150000),  # High luxury
            (150000, 500000)  # Ultra luxury
        ]
        
        price_range = random.choice(price_ranges)
        price = Decimal(str(random.randint(price_range[0], price_range[1])))
        
        # Crafting time based on price tier
        if price < 15000:
            crafting_time = random.randint(2, 6)
        elif price < 50000:
            crafting_time = random.randint(4, 12)
        elif price < 150000:
            crafting_time = random.randint(8, 18)
        else:
            crafting_time = random.randint(12, 36)
        
        # Generate description
        description = random.choice(DESCRIPTIONS)
        description += f" Crafted from premium {material.lower()} in the {style.lower()} tradition."
        
        # Generate authenticity certificate
        cert_number = f"AC-{uuid.uuid4().hex[:8].upper()}-{datetime.now().year}"
        
        # Inventory (luxury items have limited stock)
        inventory = random.randint(1, 5) if price > 100000 else random.randint(1, 10)
        
        # Image URL (placeholder for now)
        image_url = f"https://cdn.artisandesks.com/products/{uuid.uuid4().hex[:12]}.jpg"
        
        return {
            'name': name,
            'description': description,
            'price': price,
            'category': 'Artisanal Desks',
            'inventory_count': inventory,
            'image_url': image_url,
            'material': material,
            'style': style,
            'crafting_time_months': crafting_time,
            'artisan_name': artisan,
            'authenticity_certificate': cert_number
        }
    
    def insert_artisan_desk(self, desk_data):
        """Insert a single artisan desk product"""
        try:
            insert_query = """
                INSERT INTO products (
                    name, description, price, category, inventory_count, image_url,
                    material, style, crafting_time_months, artisan_name, authenticity_certificate
                ) VALUES (
                    %(name)s, %(description)s, %(price)s, %(category)s, %(inventory_count)s, %(image_url)s,
                    %(material)s, %(style)s, %(crafting_time_months)s, %(artisan_name)s, %(authenticity_certificate)s
                ) RETURNING id
            """
            
            self.cursor.execute(insert_query, desk_data)
            product_id = self.cursor.fetchone()['id']
            return product_id
        except Exception as e:
            print(f"✗ Failed to insert product '{desk_data['name']}': {e}")
            raise
    
    def seed_artisan_desks(self, count=50):
        """Generate and insert artisan desk products"""
        print(f"Generating {count} unique artisan desk products...")
        
        try:
            # Track generated combinations to ensure uniqueness
            generated_combinations = set()
            products_created = []
            
            for i in range(count):
                # Generate unique product data
                attempts = 0
                while attempts < 100:  # Prevent infinite loop
                    desk_data = self.generate_artisan_desk_data(i)
                    combination_key = (desk_data['material'], desk_data['style'], desk_data['artisan_name'])
                    
                    if combination_key not in generated_combinations:
                        generated_combinations.add(combination_key)
                        break
                    attempts += 1
                
                if attempts >= 100:
                    print(f"✗ Could not generate unique combination for product {i+1}")
                    continue
                
                # Insert product
                product_id = self.insert_artisan_desk(desk_data)
                products_created.append({
                    'id': str(product_id),
                    'name': desk_data['name'],
                    'price': float(desk_data['price']),
                    'artisan': desk_data['artisan_name']
                })
                
                print(f"✓ Created product {i+1}/{count}: {desk_data['name']} - ${desk_data['price']:,}")
            
            # Commit all changes
            self.connection.commit()
            print(f"✓ Successfully created {len(products_created)} artisan desk products")
            
            # Save summary report
            self.save_seeding_report(products_created)
            
            return True
            
        except Exception as e:
            print(f"✗ Seeding failed: {e}")
            self.connection.rollback()
            return False
    
    def save_seeding_report(self, products):
        """Save a report of created products"""
        report = {
            'seeding_date': datetime.now().isoformat(),
            'total_products': len(products),
            'total_value': sum(p['price'] for p in products),
            'products': products
        }
        
        report_file = f"database/postgresql/seeding_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        try:
            with open(report_file, 'w') as f:
                json.dump(report, f, indent=2)
            print(f"✓ Seeding report saved to {report_file}")
        except Exception as e:
            print(f"✗ Failed to save report: {e}")
    
    def verify_seeding(self):
        """Verify that products were created correctly"""
        try:
            # Count artisan desk products
            self.cursor.execute("""
                SELECT COUNT(*) as count 
                FROM products 
                WHERE category = 'Artisanal Desks' 
                AND material IS NOT NULL 
                AND artisan_name IS NOT NULL
            """)
            count = self.cursor.fetchone()['count']
            
            # Get price statistics
            self.cursor.execute("""
                SELECT 
                    MIN(price) as min_price,
                    MAX(price) as max_price,
                    AVG(price) as avg_price,
                    COUNT(DISTINCT material) as unique_materials,
                    COUNT(DISTINCT style) as unique_styles,
                    COUNT(DISTINCT artisan_name) as unique_artisans
                FROM products 
                WHERE category = 'Artisanal Desks'
            """)
            stats = self.cursor.fetchone()
            
            print(f"\n✓ Seeding Verification Results:")
            print(f"  Total Products: {count}")
            print(f"  Price Range: ${stats['min_price']:,} - ${stats['max_price']:,}")
            print(f"  Average Price: ${stats['avg_price']:,.2f}")
            print(f"  Unique Materials: {stats['unique_materials']}")
            print(f"  Unique Styles: {stats['unique_styles']}")
            print(f"  Unique Artisans: {stats['unique_artisans']}")
            
            return count == 50
            
        except Exception as e:
            print(f"✗ Verification failed: {e}")
            return False

def main():
    """Main seeding process"""
    print("🎨 Artisan Desk Product Seeding Service")
    print("=" * 50)
    
    seeder = ArtisanDeskSeeder()
    
    try:
        # Connect to database
        if not seeder.connect_database():
            sys.exit(1)
        
        # Validate schema
        if not seeder.validate_schema():
            sys.exit(1)
        
        # Clear existing products (optional)
        if '--clear' in sys.argv:
            seeder.clear_existing_artisan_desks()
        
        # Seed products
        if seeder.seed_artisan_desks(50):
            # Verify seeding
            if seeder.verify_seeding():
                print("\n🎉 Artisan desk seeding completed successfully!")
            else:
                print("\n⚠️  Seeding completed but verification failed")
                sys.exit(1)
        else:
            print("\n❌ Seeding failed")
            sys.exit(1)
    
    except KeyboardInterrupt:
        print("\n\n⚠️  Seeding interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        sys.exit(1)
    finally:
        seeder.disconnect_database()

if __name__ == "__main__":
    main()