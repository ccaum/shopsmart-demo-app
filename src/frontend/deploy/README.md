# Frontend Deployment Guide

This directory contains all the necessary configuration and scripts to deploy the shopping cart frontend to either AWS S3 (with CloudFront) or EC2.

## Prerequisites

### For S3 Deployment
- AWS CLI installed and configured
- S3 bucket created for static website hosting
- CloudFront distribution (optional but recommended)
- Domain name configured (optional)

### For EC2 Deployment
- EC2 instance running with nginx installed
- SSH access to the EC2 instance
- Domain name pointing to the EC2 instance (optional)

## Setup Instructions

### 1. Configure Environment

1. Copy the example configuration file:
   ```bash
   cp deploy/config.env.example deploy/config.env
   ```

2. Edit `deploy/config.env` with your actual values:
   - Update API service URLs
   - Set deployment target (s3 or ec2)
   - Configure S3/CloudFront settings (if using S3)
   - Configure EC2 settings (if using EC2)

### 2. Build the Frontend

Run the build script to prepare the frontend for deployment:

```bash
cd frontend
./deploy/build.sh
```

This script will:
- Create a `build` directory with optimized files
- Update API configuration for production
- Add security headers to HTML files
- Generate a deployment manifest

### 3. Deploy

Run the deployment script:

```bash
./deploy/deploy.sh
```

This will deploy to your configured target (S3 or EC2).

## Deployment Options

### Option 1: S3 + CloudFront (Recommended)

**Advantages:**
- Highly scalable and available
- Built-in CDN with CloudFront
- Cost-effective for static content
- Automatic SSL/TLS with CloudFront

**Setup Steps:**

1. Create S3 bucket:
   ```bash
   aws s3 mb s3://your-frontend-bucket
   ```

2. Enable static website hosting:
   ```bash
   aws s3 website s3://your-frontend-bucket --index-document index.html --error-document index.html
   ```

3. Apply bucket policy (update bucket name in `s3-bucket-policy.json`):
   ```bash
   aws s3api put-bucket-policy --bucket your-frontend-bucket --policy file://deploy/s3-bucket-policy.json
   ```

4. Create CloudFront distribution (optional):
   ```bash
   aws cloudfront create-distribution --distribution-config file://deploy/cloudfront-distribution.json
   ```

### Option 2: EC2 with Nginx

**Advantages:**
- Full control over server configuration
- Can proxy API requests through nginx
- Custom SSL certificate management

**Setup Steps:**

1. Install nginx on EC2:
   ```bash
   sudo apt update
   sudo apt install nginx
   ```

2. Copy nginx configuration:
   ```bash
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/frontend
   sudo ln -s /etc/nginx/sites-available/frontend /etc/nginx/sites-enabled/
   sudo rm /etc/nginx/sites-enabled/default
   ```

3. Update nginx configuration with your domain and API URLs

4. Test and reload nginx:
   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

## CORS Configuration

The deployment includes proper CORS configuration for cross-origin API calls:

### Frontend CORS Headers
- Added to nginx configuration for EC2 deployment
- Configured in CloudFront response headers policy for S3 deployment
- Includes proper preflight request handling

### API Service CORS
Ensure your API services are configured to accept requests from your frontend domain:

```python
# Example for Flask/Python services
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=['https://your-domain.com', 'https://www.your-domain.com'])
```

## Security Features

The deployment includes several security measures:

1. **Content Security Policy (CSP)**: Restricts resource loading
2. **X-Frame-Options**: Prevents clickjacking
3. **X-Content-Type-Options**: Prevents MIME type sniffing
4. **X-XSS-Protection**: Enables XSS filtering
5. **Referrer Policy**: Controls referrer information
6. **HTTPS Redirect**: Forces secure connections (CloudFront/nginx)

## Environment-Specific Configuration

The build process creates environment-specific configuration:

- **Development**: Uses localhost URLs for API services
- **Production**: Uses actual service URLs from config.env

## Monitoring and Troubleshooting

### Health Check
The deployment includes a deployment manifest at `/deployment-manifest.json` that contains:
- Build timestamp
- Environment information
- Service URLs
- CORS configuration

### Common Issues

1. **CORS Errors**: Ensure API services allow requests from your domain
2. **404 Errors**: Check that index.html fallback is configured
3. **API Connection Issues**: Verify service URLs in config.env
4. **SSL Certificate Issues**: Ensure certificates are valid and properly configured

### Logs
- **S3/CloudFront**: Check CloudFront access logs
- **EC2**: Check nginx access and error logs at `/var/log/nginx/`

## Rollback Procedure

### S3 Deployment
S3 versioning can be enabled for easy rollback:
```bash
aws s3api put-bucket-versioning --bucket your-frontend-bucket --versioning-configuration Status=Enabled
```

### EC2 Deployment
Keep previous deployment packages:
```bash
# The deploy script can be modified to keep backups
sudo cp -r /var/www/html /var/www/html.backup.$(date +%Y%m%d_%H%M%S)
```

## Performance Optimization

1. **Gzip Compression**: Enabled in nginx configuration
2. **Browser Caching**: Configured for static assets
3. **CDN**: CloudFront provides global edge caching
4. **Minification**: Can be added to build process if needed

## Cost Optimization

### S3 + CloudFront
- Use appropriate CloudFront price class
- Enable compression
- Set proper cache headers

### EC2
- Use appropriate instance size
- Consider reserved instances for production
- Monitor bandwidth usage