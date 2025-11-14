-- Rollback Migration: Remove artisan desk columns from products table
-- Version: 001
-- Description: Rollback script to remove artisan desk specific fields

-- Begin transaction for atomic rollback
BEGIN;

-- Drop the specialized artisan desks view
DROP VIEW IF EXISTS artisan_desks;

-- Restore original product_catalog view
DROP VIEW IF EXISTS product_catalog;
CREATE OR REPLACE VIEW product_catalog AS
SELECT 
    id,
    name,
    description,
    price,
    category,
    inventory_count,
    image_url,
    created_at,
    updated_at,
    CASE 
        WHEN inventory_count > 0 THEN 'in_stock'
        ELSE 'out_of_stock'
    END as availability_status,
    CASE 
        WHEN inventory_count > 10 THEN 'high'
        WHEN inventory_count > 0 THEN 'low'
        ELSE 'none'
    END as stock_level
FROM products;

-- Drop indexes created for artisan desk columns
DROP INDEX IF EXISTS idx_products_material;
DROP INDEX IF EXISTS idx_products_style;
DROP INDEX IF EXISTS idx_products_price_range;
DROP INDEX IF EXISTS idx_products_artisan;
DROP INDEX IF EXISTS idx_products_material_style;
DROP INDEX IF EXISTS idx_products_material_price;
DROP INDEX IF EXISTS idx_products_style_price;

-- Remove artisan desk columns
ALTER TABLE products 
DROP COLUMN IF EXISTS material,
DROP COLUMN IF EXISTS style,
DROP COLUMN IF EXISTS crafting_time_months,
DROP COLUMN IF EXISTS artisan_name,
DROP COLUMN IF EXISTS authenticity_certificate;

-- Remove migration record
DELETE FROM schema_migrations WHERE version = '001';

-- Commit transaction
COMMIT;