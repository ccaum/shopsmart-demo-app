# ShopSmart Source Code

This directory contains all application source code for the ShopSmart e-commerce platform.

## Directory Structure

```
src/
├── frontend/              # Frontend application (HTML, CSS, JS)
├── services/              # Backend microservices
├── database/              # Database schemas and seed data
└── README.md              # This file
```

## Services

### Frontend
- Artisan desk storefront
- Shopping cart functionality
- User authentication UI
- Product catalog browsing

### Backend Services
- **auth** - User authentication service (Lambda)
- **product-catalog** - Product catalog service (EC2)
- **order-processing** - Order processing service (EKS)

### Database
- PostgreSQL schemas and migrations
- MongoDB initialization scripts
- DynamoDB seed data
- Database seeding utilities

## Development

Each service has its own README with specific development instructions.