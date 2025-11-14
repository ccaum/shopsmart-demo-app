#!/usr/bin/env python3
"""
Product Catalog Service - Flask Application
Serves artisan desk products with enhanced filtering and search capabilities
"""

import os
import logging
import json
import boto3
from flask import Flask, jsonify, request
from flask_cors import CORS
import psycopg2
from psycopg2.extras import RealDictCursor
import redis
from botocore.exceptions import ClientError

# OpenTelemetry imports (with error handling for compatibility)
try:
    from opentelemetry import trace, metrics
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.instrumentation.flask import FlaskInstrumentor
    from opentelemetry.instrumentation.requests import RequestsInstrumentor
    from opentelemetry.sdk.resources import Resource
    OTEL_AVAILABLE = True
except ImportError as e:
    print(f"OpenTelemetry not available: {e}")
    OTEL_AVAILABLE = False

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Database configuration
DB_HOST = os.environ.get('PRODUCT_CATALOG_DB_HOST', 'localhost')
DB_PORT = os.environ.get('PRODUCT_CATALOG_DB_PORT', '5432')
DB_NAME = os.environ.get('PRODUCT_CATALOG_DB_NAME', 'shopsmart_catalog')
DB_USER = os.environ.get('PRODUCT_CATALOG_DB_USER', 'postgres')
DB_PASSWORD = os.environ.get('PRODUCT_CATALOG_DB_PASSWORD', 'password')

# Redis configuration
REDIS_HOST = os.environ.get('PRODUCT_CATALOG_REDIS_HOST', 'localhost')
REDIS_PORT = os.environ.get('PRODUCT_CATALOG_REDIS_PORT', '6379')

# Global connections
db_connection = None
redis_client = None

def get_db_credentials_from_secrets():
    """Get database credentials from AWS Secrets Manager if available"""
    secret_arn = os.environ.get('DB_SECRET_ARN')
    if not secret_arn:
        return None
    
    try:
        secrets_client = boto3.client('secretsmanager', region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-west-2'))
        response = secrets_client.get_secret_value(SecretId=secret_arn)
        secret_data = json.loads(response['SecretString'])
        return secret_data
    except Exception as e:
        logger.warning(f"Could not retrieve secrets: {e}")
        return None

def init_database():
    """Initialize database connection"""
    global db_connection
    
    # Try to get credentials from Secrets Manager
    secret_data = get_db_credentials_from_secrets()
    if secret_data:
        db_host = secret_data.get('host', DB_HOST)
        db_port = secret_data.get('port', DB_PORT)
        db_name = secret_data.get('dbname', DB_NAME)
        db_user = secret_data.get('username', DB_USER)
        db_password = secret_data.get('password', DB_PASSWORD)
    else:
        db_host = DB_HOST
        db_port = DB_PORT
        db_name = DB_NAME
        db_user = DB_USER
        db_password = DB_PASSWORD
    
    try:
        db_connection = psycopg2.connect(
            host=db_host,
            port=db_port,
            database=db_name,
            user=db_user,
            password=db_password,
            cursor_factory=RealDictCursor
        )
        logger.info("Database connection established")
        return True
    except Exception as e:
        logger.error(f"Database connection failed: {e}")
        return False

def init_redis():
    """Initialize Redis connection"""
    global redis_client
    
    try:
        redis_client = redis.Redis(
            host=REDIS_HOST,
            port=int(REDIS_PORT),
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5
        )
        # Test connection
        redis_client.ping()
        logger.info("Redis connection established")
        return True
    except Exception as e:
        logger.warning(f"Redis connection failed: {e}")
        redis_client = None
        return False

def setup_opentelemetry():
    """Setup OpenTelemetry if available"""
    if not OTEL_AVAILABLE:
        return
    
    try:
        # Configure OpenTelemetry with environment variables
        service_name = os.environ.get('OTEL_SERVICE_NAME', 'product-catalog-service')
        service_version = os.environ.get('OTEL_SERVICE_VERSION', '1.0.0')
        environment = os.environ.get('DEPLOYMENT_ENVIRONMENT', 'production')

        # Create resource with service information
        resource = Resource.create({
            "service.name": service_name,
            "service.version": service_version,
            "deployment.environment": environment,
        })

        trace.set_tracer_provider(TracerProvider(resource=resource))

        # OTLP exporter configuration from environment variables
        otel_endpoint = os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')
        
        if otel_endpoint and otel_endpoint != 'disabled':
            # Configure trace exporter
            otlp_trace_exporter = OTLPSpanExporter(
                endpoint=f"{otel_endpoint}/v1/traces"
            )
            span_processor = BatchSpanProcessor(otlp_trace_exporter)
            trace.get_tracer_provider().add_span_processor(span_processor)

            # Configure metrics exporter
            otlp_metric_exporter = OTLPMetricExporter(
                endpoint=f"{otel_endpoint}/v1/metrics"
            )
            metric_reader = PeriodicExportingMetricReader(otlp_metric_exporter)
            metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))

            # Configure logs exporter
            logger_provider = LoggerProvider(resource=resource)
            otlp_log_exporter = OTLPLogExporter(
                endpoint=f"{otel_endpoint}/v1/logs"
            )
            logger_provider.add_log_record_processor(BatchLogRecordProcessor(otlp_log_exporter))
            
            # Attach OTEL handler to root logger
            handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
            logging.getLogger().addHandler(handler)

            # Auto-instrument Flask
            FlaskInstrumentor().instrument_app(app)
            RequestsInstrumentor().instrument()
            
            logger.info(f"OpenTelemetry configured: endpoint={otel_endpoint}, service={service_name}")
    except Exception as e:
        logger.warning(f"OpenTelemetry setup failed: {e}")

@app.route('/health')
def health():
    """Health check endpoint with comprehensive dependency verification"""
    from datetime import datetime
    
    health_status = {
        'status': 'healthy',
        'service': 'product-catalog',
        'version': '1.0.0',
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'dependencies': {}
    }
    
    # Check PostgreSQL database connectivity
    try:
        if db_connection:
            cursor = db_connection.cursor()
            cursor.execute('SELECT 1')
            cursor.fetchone()
            cursor.close()
            health_status['dependencies']['postgresql'] = 'connected'
        else:
            health_status['status'] = 'unhealthy'
            health_status['dependencies']['postgresql'] = 'not_initialized'
            health_status['error'] = 'Database connection not initialized'
    except Exception as e:
        logger.error(f"PostgreSQL health check failed: {e}")
        health_status['status'] = 'unhealthy'
        health_status['dependencies']['postgresql'] = f'error: {str(e)}'
        health_status['error'] = 'PostgreSQL connectivity failed'
    
    # Check Redis connectivity
    try:
        if redis_client:
            redis_client.ping()
            health_status['dependencies']['redis'] = 'connected'
        else:
            health_status['status'] = 'degraded' if health_status['status'] == 'healthy' else health_status['status']
            health_status['dependencies']['redis'] = 'not_available'
            health_status['warning'] = 'Redis cache not available - operating without cache'
    except Exception as e:
        logger.warning(f"Redis health check failed: {e}")
        health_status['status'] = 'degraded' if health_status['status'] == 'healthy' else health_status['status']
        health_status['dependencies']['redis'] = f'error: {str(e)}'
        if 'warning' not in health_status:
            health_status['warning'] = 'Redis cache unavailable - operating without cache'
    
    # Check environment configuration
    required_env_vars = ['PRODUCT_CATALOG_DB_HOST', 'PRODUCT_CATALOG_DB_NAME']
    missing_env_vars = [var for var in required_env_vars if not os.environ.get(var)]
    
    if missing_env_vars:
        health_status['status'] = 'degraded' if health_status['status'] == 'healthy' else health_status['status']
        health_status['dependencies']['environment'] = f'missing: {", ".join(missing_env_vars)}'
        if 'warning' not in health_status:
            health_status['warning'] = f'Missing environment variables: {", ".join(missing_env_vars)}'
    else:
        health_status['dependencies']['environment'] = 'configured'
    
    # Check OpenTelemetry availability
    health_status['dependencies']['opentelemetry'] = 'available' if OTEL_AVAILABLE else 'not_available'
    
    # Return appropriate status code
    status_code = 200 if health_status['status'] == 'healthy' else 503
    return jsonify(health_status), status_code

@app.route('/api/health')
def api_health():
    """API Health check endpoint for load balancer"""
    return health()

@app.route('/products')
def get_products():
    """Get all products with optional filtering"""
    try:
        # Get query parameters
        category = request.args.get('category')
        material = request.args.get('material')
        style = request.args.get('style')
        min_price = request.args.get('min_price', type=float)
        max_price = request.args.get('max_price', type=float)
        page = request.args.get('page', 1, type=int)
        page_size = min(request.args.get('page_size', 20, type=int), 100)
        
        # Build query
        query = "SELECT * FROM products WHERE 1=1"
        params = []
        
        if category:
            query += " AND category = %s"
            params.append(category)
        
        if material:
            query += " AND material ILIKE %s"
            params.append(f"%{material}%")
        
        if style:
            query += " AND style ILIKE %s"
            params.append(f"%{style}%")
        
        if min_price is not None:
            query += " AND price >= %s"
            params.append(min_price)
        
        if max_price is not None:
            query += " AND price <= %s"
            params.append(max_price)
        
        # Add pagination
        offset = (page - 1) * page_size
        query += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
        params.extend([page_size, offset])
        
        # Execute query
        if not db_connection:
            if not init_database():
                return jsonify({"error": "Database connection failed"}), 500
        
        cursor = db_connection.cursor(cursor_factory=RealDictCursor)
        cursor.execute(query, params)
        products = cursor.fetchall()
        
        # Convert to list of dicts and handle Decimal types
        products_list = []
        for product in products:
            product_dict = dict(product)
            # Convert Decimal to float for JSON serialization
            if 'price' in product_dict and product_dict['price']:
                product_dict['price'] = float(product_dict['price'])
            products_list.append(product_dict)
        
        # Get total count for pagination
        count_query = query.replace("SELECT *", "SELECT COUNT(*)").split("ORDER BY")[0]
        cursor.execute(count_query, params[:-2])  # Remove LIMIT and OFFSET params
        count_result = cursor.fetchone()
        total_count = count_result['count'] if isinstance(count_result, dict) else count_result[0]
        
        cursor.close()
        
        return jsonify({
            "products": products_list,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total_count": total_count,
                "total_pages": (total_count + page_size - 1) // page_size
            }
        })
        
    except Exception as e:
        logger.error(f"Error fetching products: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/products/<int:product_id>')
def get_product(product_id):
    """Get a specific product by ID"""
    try:
        if not db_connection:
            if not init_database():
                return jsonify({"error": "Database connection failed"}), 500
        
        cursor = db_connection.cursor()
        cursor.execute("SELECT * FROM products WHERE id = %s", (product_id,))
        product = cursor.fetchone()
        cursor.close()
        
        if not product:
            return jsonify({"error": "Product not found"}), 404
        
        product_dict = dict(product)
        if 'price' in product_dict and product_dict['price']:
            product_dict['price'] = float(product_dict['price'])
        
        return jsonify(product_dict)
        
    except Exception as e:
        logger.error(f"Error fetching product {product_id}: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/products/materials')
def get_materials():
    """Get all available materials"""
    try:
        if not db_connection:
            if not init_database():
                return jsonify({"error": "Database connection failed"}), 500
        
        cursor = db_connection.cursor()
        cursor.execute("SELECT DISTINCT material FROM products WHERE material IS NOT NULL ORDER BY material")
        materials = [row[0] for row in cursor.fetchall()]
        cursor.close()
        
        return jsonify({"materials": materials})
        
    except Exception as e:
        logger.error(f"Error fetching materials: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/products/styles')
def get_styles():
    """Get all available styles"""
    try:
        if not db_connection:
            if not init_database():
                return jsonify({"error": "Database connection failed"}), 500
        
        cursor = db_connection.cursor()
        cursor.execute("SELECT DISTINCT style FROM products WHERE style IS NOT NULL ORDER BY style")
        styles = [row[0] for row in cursor.fetchall()]
        cursor.close()
        
        return jsonify({"styles": styles})
        
    except Exception as e:
        logger.error(f"Error fetching styles: {e}")
        return jsonify({"error": "Internal server error"}), 500

# Initialize connections on startup
setup_opentelemetry()
init_database()
init_redis()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
