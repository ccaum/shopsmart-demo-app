import json
import boto3
import urllib3
import time
import os

ecs = boto3.client('ecs')
http = urllib3.PoolManager()

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    response_data = {}
    status = 'SUCCESS'
    reason = None
    
    try:
        if event['RequestType'] in ['Create', 'Update']:
            cluster = os.environ['CLUSTER_NAME']
            task_def = os.environ['TASK_DEFINITION']
            subnets = os.environ['SUBNETS'].split(',')
            security_group = os.environ['SECURITY_GROUP']
            
            print(f"Running task in cluster {cluster}")
            
            # Run the task
            response = ecs.run_task(
                cluster=cluster,
                taskDefinition=task_def,
                launchType='FARGATE',
                networkConfiguration={
                    'awsvpcConfiguration': {
                        'subnets': subnets,
                        'securityGroups': [security_group],
                        'assignPublicIp': 'DISABLED'
                    }
                }
            )
            
            if not response['tasks']:
                raise Exception(f"Failed to start task: {response.get('failures', [])}")
            
            task_arn = response['tasks'][0]['taskArn']
            print(f"Task started: {task_arn}")
            
            # Wait for task to complete (max 10 minutes)
            for i in range(60):
                time.sleep(10)
                task_response = ecs.describe_tasks(cluster=cluster, tasks=[task_arn])
                
                if not task_response['tasks']:
                    raise Exception("Task disappeared")
                
                task = task_response['tasks'][0]
                last_status = task['lastStatus']
                print(f"Task status: {last_status}")
                
                if last_status == 'STOPPED':
                    exit_code = task['containers'][0].get('exitCode', 1)
                    if exit_code == 0:
                        response_data['Message'] = 'Database seeded successfully'
                        break
                    else:
                        raise Exception(f"Task failed with exit code {exit_code}")
            else:
                raise Exception("Task timed out after 10 minutes")
                
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
