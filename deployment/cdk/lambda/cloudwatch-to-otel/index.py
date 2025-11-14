import json
import gzip
import base64
import os
import re
from urllib import request
from urllib.error import URLError
from datetime import datetime

# Forward CloudWatch logs to OTEL collector v4
OTEL_ENDPOINT = os.environ['OTEL_ENDPOINT']

def extract_severity(message):
    """Extract severity level from CloudWatch log message"""
    if '[ERROR]' in message or '"level":"error"' in message.lower():
        return 'ERROR'
    elif '[WARNING]' in message or '[WARN]' in message or '"level":"warn"' in message.lower():
        return 'WARN'
    elif '[INFO]' in message or '"level":"info"' in message.lower():
        return 'INFO'
    elif '[DEBUG]' in message or '"level":"debug"' in message.lower():
        return 'DEBUG'
    else:
        return 'INFO'

def handler(event, context):
    print(f"Forwarder invoked, OTEL endpoint: {OTEL_ENDPOINT}")
    
    # Decode and decompress CloudWatch Logs data
    compressed_payload = base64.b64decode(event['awslogs']['data'])
    uncompressed_payload = gzip.decompress(compressed_payload)
    log_data = json.loads(uncompressed_payload)
    
    print(f"Processing {len(log_data['logEvents'])} log events from {log_data['logGroup']}")
    
    # Convert CloudWatch logs to OTEL log format
    otel_logs = []
    for log_event in log_data['logEvents']:
        severity = extract_severity(log_event['message'])
        otel_log = {
            "timeUnixNano": str(log_event['timestamp'] * 1000000),
            "severityText": severity,
            "body": {"stringValue": log_event['message']},
            "attributes": [
                {"key": "log.group", "value": {"stringValue": log_data['logGroup']}},
                {"key": "log.stream", "value": {"stringValue": log_data['logStream']}},
                {"key": "aws.request_id", "value": {"stringValue": log_event.get('id', '')}}
            ]
        }
        otel_logs.append(otel_log)
    
    # Send to OTEL collector
    payload = {
        "resourceLogs": [{
            "resource": {
                "attributes": [
                    {"key": "service.name", "value": {"stringValue": os.environ.get('SERVICE_NAME', 'auth-service')}},
                    {"key": "source", "value": {"stringValue": "cloudwatch"}}
                ]
            },
            "scopeLogs": [{
                "logRecords": otel_logs
            }]
        }]
    }
    
    try:
        req = request.Request(
            f"{OTEL_ENDPOINT}/v1/logs",
            data=json.dumps(payload).encode('utf-8'),
            headers={"Content-Type": "application/json"},
            method='POST'
        )
        with request.urlopen(req, timeout=5) as response:
            print(f"Forwarded {len(otel_logs)} logs to OTEL collector: {response.status}")
    except URLError as e:
        print(f"Error forwarding logs to OTEL: {e}")
    except Exception as e:
        print(f"Unexpected error: {e}")
    
    return {'statusCode': 200}
