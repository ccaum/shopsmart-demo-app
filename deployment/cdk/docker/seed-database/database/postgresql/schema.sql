-- ShopSmart Product Catalog Database Schema
-- PostgreSQL schema for product catalog service

-- Create database (run as superuser)
-- CREATE DATABASE shopsmart_catalog;

-- Connect to the database
-- \c shopsmart_catalog;

-- Create extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products table
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    category VARCHAR(100) NOT NULL,
    inventory_count INTEGER DEFAULT 0 CHECK (inventory_count >= 0),
    image_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_inventory ON products(inventory_count);

-- Full-text search index for product search
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER update_products_updated_at 
    BEFORE UPDATE ON products 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create a view for product catalog with computed fields
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

-- Create indexes on commonly queried combinations
CREATE INDEX IF NOT EXISTS idx_products_category_price ON products(category, price);
CREATE INDEX IF NOT EXISTS idx_products_category_inventory ON products(category, inventory_count);