import json
import os
import time
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
from opentelemetry.instrumentation.aws_lambda import AwsLambdaInstrumentor
from opentelemetry.sdk.resources import Resource
import logging

# Service resource
resource = Resource.create({
    "service.name": "auth-service-19987",
    "deployment.environment": "production"
})

# Configure Tracing
trace_provider = TracerProvider(resource=resource)
otlp_trace_exporter = OTLPSpanExporter(
    endpoint=os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://internal-shopsmart-prod-otel-312846401.us-west-2.elb.amazonaws.com:4318/v1/traces')
)
trace_provider.add_span_processor(BatchSpanProcessor(otlp_trace_exporter))
trace.set_tracer_provider(trace_provider)
tracer = trace.get_tracer(__name__)

# Configure Metrics
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(
        endpoint=os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://internal-shopsmart-prod-otel-312846401.us-west-2.elb.amazonaws.com:4318/v1/metrics')
    )
)
meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
metrics.set_meter_provider(meter_provider)
meter = metrics.get_meter(__name__)

# Create metrics
request_counter = meter.create_counter("auth.requests", description="Total auth requests")
error_counter = meter.create_counter("auth.errors", description="Total auth errors")
duration_histogram = meter.create_histogram("auth.duration", unit="ms", description="Request duration")

# Configure Logging
logger_provider = LoggerProvider(resource=resource)
otlp_log_exporter = OTLPLogExporter(
    endpoint=os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://internal-shopsmart-prod-otel-312846401.us-west-2.elb.amazonaws.com:4318/v1/logs')
)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(otlp_log_exporter))
handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)

# Auto-instrument Lambda
AwsLambdaInstrumentor().instrument()

def lambda_handler(event, context):
    start_time = time.time()
    
    with tracer.start_as_current_span("auth_handler") as span:
        try:
            method = event.get('httpMethod', 'GET')
            path = event.get('path', '/')
            
            span.set_attribute("http.method", method)
            span.set_attribute("http.path", path)
            span.set_attribute("service.name", "auth-service-19987")
            
            # Log request
            logging.info(f"Processing {method} request to {path}")
            
            # Increment request counter
            request_counter.add(1, {"method": method, "path": path})
            
            # Simulate auth logic
            response = {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Auth service healthy',
                    'service': 'auth-service-19987',
                    'timestamp': int(time.time())
                })
            }
            
            # Record duration
            duration = (time.time() - start_time) * 1000
            duration_histogram.record(duration, {"method": method, "status": "200"})
            
            logging.info(f"Request completed successfully in {duration:.2f}ms")
            
            return response
            
        except Exception as e:
            error_counter.add(1, {"error_type": type(e).__name__})
            logging.error(f"Error processing request: {str(e)}")
            span.set_attribute("error", True)
            span.set_attribute("error.message", str(e))
            raise
