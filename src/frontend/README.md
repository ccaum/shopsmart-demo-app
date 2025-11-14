# ShopSmart Frontend

A modern, responsive web frontend for the ShopSmart e-commerce demo application.

## Features

### Implemented (Subtask 5.1)
- ✅ Product catalog display with responsive grid layout
- ✅ Product search functionality with debounced input
- ✅ Category filtering
- ✅ Pagination for product listings
- ✅ Product detail modal with add to cart functionality
- ✅ Responsive design for mobile and desktop
- ✅ Loading states and error handling

### To Be Implemented
- 🔄 User authentication UI (Subtask 5.2)
- 🔄 Shopping cart interface (Subtask 5.3)
- 🔄 Checkout and order management (Subtask 5.4)
- 🔄 Deployment configuration (Subtask 5.5)

## Architecture

The frontend is built with vanilla JavaScript using a modular architecture:

- **index.html** - Main HTML structure
- **css/styles.css** - Responsive CSS styles
- **js/config.js** - API configuration and environment settings
- **js/products.js** - Product browsing and search functionality
- **js/auth.js** - Authentication management (placeholder)
- **js/cart.js** - Shopping cart management (placeholder)
- **js/app.js** - Main application coordinator

## API Integration

The frontend integrates with three backend services:

1. **Product Catalog Service** (EC2) - Product browsing and search
2. **Authentication Service** (Lambda) - User auth and cart management
3. **Order Processing Service** (ECS) - Order creation and history

## Configuration

API endpoints are configured in `js/config.js` with environment detection:

- **Development**: Uses localhost URLs for local testing
- **Production**: Uses AWS service URLs (to be configured during deployment)

## Usage

### Local Development

1. Serve the frontend files using a local web server:
   ```bash
   # Using Python
   cd frontend
   python -m http.server 8080
   
   # Using Node.js
   npx serve .
   
   # Using PHP
   php -S localhost:8080
   ```

2. Open http://localhost:8080 in your browser

3. Ensure backend services are running:
   - Product Catalog Service on port 5000
   - Order Processing Service on port 8000
   - Authentication Service via API Gateway

### Features Demo

- Browse products with search and category filtering
- Click on products to view detailed information
- Add products to cart (requires authentication)
- Responsive design works on mobile and desktop

## Browser Support

- Modern browsers with ES6+ support
- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Performance Features

- Debounced search input (300ms delay)
- Lazy loading of product details
- Responsive images
- Efficient DOM updates
- Local storage for session management

## Security Features

- HTML escaping for user-generated content
- CORS handling for cross-origin requests
- Session validation
- Input sanitization

## Next Steps

The remaining subtasks will add:

1. **Authentication UI** - Login/register forms and session management
2. **Cart Interface** - Shopping cart display and management
3. **Checkout Flow** - Order placement and confirmation
4. **Deployment Config** - Production deployment setup