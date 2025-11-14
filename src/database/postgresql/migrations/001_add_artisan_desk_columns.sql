-- Migration: Add artisan desk columns to products table
-- Version: 001
-- Description: Extends products table with artisan desk specific fields

-- Begin transaction for atomic migration
BEGIN;

-- Add new columns for artisan desk products
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS material VARCHAR(100),
ADD COLUMN IF NOT EXISTS style VARCHAR(50),
ADD COLUMN IF NOT EXISTS crafting_time_months INTEGER CHECK (crafting_time_months > 0),
ADD COLUMN IF NOT EXISTS artisan_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS authenticity_certificate VARCHAR(255);

-- Create indexes for filtering performance
CREATE INDEX IF NOT EXISTS idx_products_material ON products(material) WHERE material IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_style ON products(style) WHERE style IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_price_range ON products(price) WHERE price BETWEEN 5000 AND 500000;
CREATE INDEX IF NOT EXISTS idx_products_artisan ON products(artisan_name) WHERE artisan_name IS NOT NULL;

-- Create composite indexes for common filter combinations
CREATE INDEX IF NOT EXISTS idx_products_material_style ON products(material, style) WHERE material IS NOT NULL AND style IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_material_price ON products(material, price) WHERE material IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_style_price ON products(style, price) WHERE style IS NOT NULL;

-- Update the product_catalog view to include new fields
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
    material,
    style,
    crafting_time_months,
    artisan_name,
    authenticity_certificate,
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
    END as stock_level,
    CASE 
        WHEN material IS NOT NULL AND style IS NOT NULL AND artisan_name IS NOT NULL THEN 'artisan_desk'
        ELSE 'standard_product'
    END as product_type
FROM products;

-- Create a specialized view for artisan desks only
CREATE OR REPLACE VIEW artisan_desks AS
SELECT 
    id,
    name,
    description,
    price,
    category,
    inventory_count,
    image_url,
    material,
    style,
    crafting_time_months,
    artisan_name,
    authenticity_certificate,
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
FROM products
WHERE material IS NOT NULL 
  AND style IS NOT NULL 
  AND artisan_name IS NOT NULL
  AND category = 'Artisanal Desks';

-- Insert migration record
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(10) PRIMARY KEY,
    description TEXT,
    applied_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO schema_migrations (version, description) 
VALUES ('001', 'Add artisan desk columns to products table')
ON CONFLICT (version) DO NOTHING;

-- Commit transaction
COMMIT;