import json
import urllib3
import subprocess
import os

http = urllib3.PoolManager()

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    response_data = {}
    reason = None
    status = 'SUCCESS'
    
    try:
        if event['RequestType'] in ['Create', 'Update']:
            # Get database credentials from environment
            db_host = os.environ['DB_HOST']
            db_name = os.environ['DB_NAME']
            db_user = os.environ['DB_USER']
            db_password = os.environ['DB_PASSWORD']
            
            # Set environment for subprocess
            env = os.environ.copy()
            env['PGPASSWORD'] = db_password
            
            # Apply base schema
            print("Applying base schema...")
            schema_result = subprocess.run(
                ['psql', '-h', db_host, '-U', db_user, '-d', db_name, '-f', '/var/task/schema.sql'],
                env=env,
                capture_output=True,
                text=True
            )
            print(f"Schema output: {schema_result.stdout}")
            if schema_result.returncode != 0:
                print(f"Schema errors: {schema_result.stderr}")
            
            # Run migration
            print("Running migration...")
            migration_result = subprocess.run(
                ['psql', '-h', db_host, '-U', db_user, '-d', db_name, '-f', '/var/task/001_add_artisan_desk_columns.sql'],
                env=env,
                capture_output=True,
                text=True
            )
            print(f"Migration output: {migration_result.stdout}")
            if migration_result.returncode != 0:
                print(f"Migration errors: {migration_result.stderr}")
            
            # Run seed script
            print("Running seed script...")
            seed_env = env.copy()
            seed_env.update({
                'DB_HOST': db_host,
                'DB_NAME': db_name,
                'DB_USER': db_user,
                'DB_PASSWORD': db_password,
                'DB_PORT': '5432'
            })
            
            seed_result = subprocess.run(
                ['python3', '/var/task/seed_products.py'],
                env=seed_env,
                capture_output=True,
                text=True
            )
            print(f"Seed output: {seed_result.stdout}")
            if seed_result.returncode != 0:
                print(f"Seed errors: {seed_result.stderr}")
                raise Exception(f"Seeding failed: {seed_result.stderr}")
            
            response_data['Message'] = 'Database seeded successfully'
            
    except Exception as e:
        print(f"Error: {str(e)}")
        status = 'FAILED'
        reason = str(e)
        response_data['Message'] = str(e)
    
    send_response(event, context, status, response_data, reason)
    return response_data

def send_response(event, context, status, response_data, reason=None):
    response_body = {
        'Status': status,
        'Reason': reason or f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': response_data
    }
    
    print(f"Response: {json.dumps(response_body)}")
    
    http.request(
        'PUT',
        event['ResponseURL'],
        body=json.dumps(response_body),
        headers={'Content-Type': ''}
    )
