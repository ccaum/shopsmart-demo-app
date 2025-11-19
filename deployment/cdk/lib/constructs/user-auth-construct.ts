import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logs_destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';

export interface UserAuthConstructProps {
  vpc: ec2.IVpc;
  privateAppSubnets: ec2.ISubnet[];
  projectName: string;
  environment: string;
  dynamodbReadCapacity: number;
  dynamodbWriteCapacity: number;
  lambdaLoginMemory: number;
  otelLayer: lambda.ILayerVersion;
}

export class UserAuthConstruct extends Construct {
  public readonly apiGatewayUrl: string;
  public readonly lambdaExecutionRoleArn: string;

  constructor(scope: Construct, id: string, props: UserAuthConstructProps) {
    super(scope, id);

    // DynamoDB Table for User Data
    const userTable = new dynamodb.Table(this, 'UserTable', {
      tableName: `${props.projectName}-${props.environment}-users`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: props.dynamodbReadCapacity, // Deliberately low to match throttling issues
      writeCapacity: props.dynamodbWriteCapacity, // Deliberately low to match throttling issues
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes
    });

    // Add GSI for email lookups
    userTable.addGlobalSecondaryIndex({
      indexName: 'EmailIndex',
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING,
      },
      readCapacity: props.dynamodbReadCapacity,
      writeCapacity: props.dynamodbWriteCapacity,
    });

    // DynamoDB Table for Sessions
    const sessionTable = new dynamodb.Table(this, 'SessionTable', {
      tableName: `${props.projectName}-${props.environment}-sessions`,
      partitionKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: props.dynamodbReadCapacity,
      writeCapacity: props.dynamodbWriteCapacity,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes
    });

    // DynamoDB Table for Shopping Carts
    const cartTable = new dynamodb.Table(this, 'CartTable', {
      tableName: `${props.projectName}-${props.environment}-carts`,
      partitionKey: {
        name: 'cartId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: props.dynamodbReadCapacity,
      writeCapacity: props.dynamodbWriteCapacity,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes
    });

    // Add GSI for userId lookups
    cartTable.addGlobalSecondaryIndex({
      indexName: 'UserIdIndex',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      readCapacity: props.dynamodbReadCapacity,
      writeCapacity: props.dynamodbWriteCapacity,
    });

    // Lambda Execution Role
    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // DynamoDB permissions
    userTable.grantReadWriteData(lambdaExecutionRole);
    sessionTable.grantReadWriteData(lambdaExecutionRole);
    cartTable.grantReadWriteData(lambdaExecutionRole);

    // Additional permissions for enhanced cart management
    lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem'
      ],
      resources: [
        userTable.tableArn,
        sessionTable.tableArn,
        cartTable.tableArn,
        `${cartTable.tableArn}/index/*`
      ],
    }));

    // CloudWatch metrics permissions for cart analytics
    lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData'
      ],
      resources: ['*'],
    }));

    // Parameter Store access for cart configuration
    lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${props.projectName}/${props.environment}/auth/*`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${props.projectName}/${props.environment}/opentelemetry/*`
      ],
    }));

    // Security Group for Lambda functions
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for User Authentication Lambda functions',
      allowAllOutbound: true,
    });

    // Read OpenTelemetry Collector endpoint from SSM Parameter Store
    const otelCollectorUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.projectName}/${props.environment}/opentelemetry/collector-url`
    );

    // Login Lambda Function
    const loginFunction = new lambda.Function(this, 'LoginFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      description: 'User login with structured logging v6',
      memorySize: props.lambdaLoginMemory,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      layers: [props.otelLayer],
      environment: {
        USER_TABLE_NAME: userTable.tableName,
        SESSION_TABLE_NAME: sessionTable.tableName,
        
        // OpenTelemetry configuration
        OTEL_EXPORTER_OTLP_ENDPOINT: otelCollectorUrl,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_SERVICE_NAME: `auth-service-${cdk.Stack.of(this).account}`,
        OTEL_RESOURCE_ATTRIBUTES: `service.name=auth-service-${cdk.Stack.of(this).account},service.version=1.0.0,deployment.environment=${props.environment}`,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
        
        // Configure ADOT Lambda extension to export to external collector
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import hashlib
import uuid
import os
import logging
from datetime import datetime, timedelta

# Configure structured logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
user_table = None
session_table = None

def get_tables():
    global user_table, session_table
    if user_table is None:
        user_table = dynamodb.Table(os.environ['USER_TABLE_NAME'])
    if session_table is None:
        session_table = dynamodb.Table(os.environ['SESSION_TABLE_NAME'])
    return user_table, session_table

def handler(event, context):
    request_id = context.aws_request_id
    method = event.get('httpMethod', 'UNKNOWN')
    path = event.get('path', 'UNKNOWN')
    
    try:
        user_table, session_table = get_tables()
        
        logger.info(json.dumps({
            'event': 'login_attempt',
            'request_id': request_id,
            'method': method,
            'path': path,
            'timestamp': datetime.now().isoformat()
        }))
        
        body = json.loads(event['body'])
        email = body.get('email')
        password = body.get('password')
        
        if not email or not password:
            logger.warning(json.dumps({
                'event': 'login_failed',
                'reason': 'missing_credentials',
                'status_code': 400,
                'request_id': request_id,
                'method': method,
                'path': path
            }))
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Email and password are required'})
            }
        
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        
        response = user_table.query(
            IndexName='EmailIndex',
            KeyConditionExpression='email = :email',
            ExpressionAttributeValues={':email': email}
        )
        
        if not response['Items']:
            logger.warning(json.dumps({
                'event': 'login_failed',
                'reason': 'invalid_credentials',
                'status_code': 401,
                'request_id': request_id,
                'method': method,
                'path': path
            }))
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Invalid credentials'})
            }
        
        user = response['Items'][0]
        
        if user['passwordHash'] != password_hash:
            logger.warning(json.dumps({
                'event': 'login_failed',
                'reason': 'invalid_password',
                'status_code': 401,
                'request_id': request_id,
                'method': method,
                'path': path
            }))
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Invalid credentials'})
            }
        
        session_id = str(uuid.uuid4())
        ttl = int((datetime.now() + timedelta(hours=24)).timestamp())
        
        session_table.put_item(
            Item={
                'sessionId': session_id,
                'userId': user['userId'],
                'ttl': ttl,
                'createdAt': datetime.now().isoformat()
            }
        )
        
        logger.info(json.dumps({
            'event': 'login_success',
            'status_code': 200,
            'request_id': request_id,
            'method': method,
            'path': path
        }))
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'sessionId': session_id,
                'userId': user['userId'],
                'email': user['email']
            })
        }
        
    except Exception as e:
        logger.error(json.dumps({
            'event': 'login_error',
            'error': str(e),
            'error_type': type(e).__name__,
            'status_code': 500,
            'request_id': request_id,
            'method': method,
            'path': path,
            'timestamp': datetime.now().isoformat()
        }))
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Register Lambda Function
    const registerFunction = new lambda.Function(this, 'RegisterFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256, // Normal sizing for register function
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        USER_TABLE_NAME: userTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import hashlib
import uuid
import os
from datetime import datetime

dynamodb = boto3.resource('dynamodb')
user_table = dynamodb.Table(os.environ['USER_TABLE_NAME'])

def handler(event, context):
    try:
        body = json.loads(event['body'])
        email = body.get('email')
        password = body.get('password')
        name = body.get('name')
        
        if not email or not password or not name:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Email, password, and name are required'})
            }
        
        # Check if user already exists
        response = user_table.query(
            IndexName='EmailIndex',
            KeyConditionExpression='email = :email',
            ExpressionAttributeValues={':email': email}
        )
        
        if response['Items']:
            return {
                'statusCode': 409,
                'body': json.dumps({'error': 'User already exists'})
            }
        
        # Hash password (in production, use proper password hashing)
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        
        # Create user
        user_id = str(uuid.uuid4())
        user_table.put_item(
            Item={
                'userId': user_id,
                'email': email,
                'name': name,
                'passwordHash': password_hash,
                'createdAt': datetime.now().isoformat()
            }
        )
        
        return {
            'statusCode': 201,
            'body': json.dumps({
                'userId': user_id,
                'email': email,
                'name': name
            })
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Validate Session Lambda Function
    const validateSessionFunction = new lambda.Function(this, 'ValidateSessionFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        SESSION_TABLE_NAME: sessionTable.tableName,
        USER_TABLE_NAME: userTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

dynamodb = boto3.resource('dynamodb')
session_table = dynamodb.Table(os.environ['SESSION_TABLE_NAME'])
user_table = dynamodb.Table(os.environ['USER_TABLE_NAME'])

def handler(event, context):
    try:
        session_id = event['pathParameters']['sessionId']
        
        # Get session
        response = session_table.get_item(
            Key={'sessionId': session_id}
        )
        
        if 'Item' not in response:
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Invalid session'})
            }
        
        session = response['Item']
        
        # Get user details
        user_response = user_table.get_item(
            Key={'userId': session['userId']}
        )
        
        if 'Item' not in user_response:
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'User not found'})
            }
        
        user = user_response['Item']
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'userId': user['userId'],
                'email': user['email'],
                'name': user['name'],
                'sessionId': session_id
            })
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Get Cart Lambda Function
    const getCartFunction = new lambda.Function(this, 'GetCartFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        CART_TABLE_NAME: cartTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
cart_table = dynamodb.Table(os.environ['CART_TABLE_NAME'])

def decimal_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError

def handler(event, context):
    try:
        user_id = event['pathParameters']['userId']
        
        # Query cart items for user
        response = cart_table.query(
            IndexName='UserIdIndex',
            KeyConditionExpression='userId = :userId',
            ExpressionAttributeValues={':userId': user_id}
        )
        
        cart_items = response['Items']
        
        # Calculate total
        total_amount = sum(float(item.get('price', 0)) * int(item.get('quantity', 0)) for item in cart_items)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({
                'items': cart_items,
                'totalAmount': total_amount,
                'itemCount': len(cart_items)
            }, default=decimal_default)
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Add to Cart Lambda Function
    const addToCartFunction = new lambda.Function(this, 'AddToCartFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        CART_TABLE_NAME: cartTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os
import time
from datetime import datetime, timedelta
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
cart_table = dynamodb.Table(os.environ['CART_TABLE_NAME'])

def handler(event, context):
    try:
        user_id = event['pathParameters']['userId']
        body = json.loads(event['body'])
        
        product_id = body.get('productId')
        quantity = int(body.get('quantity', 1))
        price = Decimal(str(body.get('price', 0)))
        name = body.get('name', '')
        
        if not product_id or quantity <= 0:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Product ID and valid quantity are required'})
            }
        
        # Create cart item ID
        cart_id = f"{user_id}#{product_id}"
        
        # Set TTL for 30 days from now
        ttl = int((datetime.now() + timedelta(days=30)).timestamp())
        
        # Check if item already exists in cart
        try:
            response = cart_table.get_item(Key={'cartId': cart_id})
            if 'Item' in response:
                # Update existing item quantity
                existing_quantity = int(response['Item']['quantity'])
                new_quantity = existing_quantity + quantity
                
                cart_table.update_item(
                    Key={'cartId': cart_id},
                    UpdateExpression='SET quantity = :quantity, updatedAt = :updatedAt, #ttl = :ttl',
                    ExpressionAttributeNames={'#ttl': 'ttl'},
                    ExpressionAttributeValues={
                        ':quantity': new_quantity,
                        ':updatedAt': datetime.now().isoformat(),
                        ':ttl': ttl
                    }
                )
                
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
                    },
                    'body': json.dumps({
                        'message': 'Item quantity updated in cart',
                        'cartId': cart_id,
                        'quantity': new_quantity
                    })
                }
            else:
                # Add new item to cart
                cart_table.put_item(
                    Item={
                        'cartId': cart_id,
                        'userId': user_id,
                        'productId': product_id,
                        'name': name,
                        'price': price,
                        'quantity': quantity,
                        'addedAt': datetime.now().isoformat(),
                        'updatedAt': datetime.now().isoformat(),
                        'ttl': ttl
                    }
                )
                
                return {
                    'statusCode': 201,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
                    },
                    'body': json.dumps({
                        'message': 'Item added to cart',
                        'cartId': cart_id,
                        'quantity': quantity
                    })
                }
                
        except Exception as e:
            print(f"DynamoDB Error: {str(e)}")
            raise e
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Update Cart Item Lambda Function
    const updateCartItemFunction = new lambda.Function(this, 'UpdateCartItemFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        CART_TABLE_NAME: cartTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')
cart_table = dynamodb.Table(os.environ['CART_TABLE_NAME'])

def handler(event, context):
    try:
        user_id = event['pathParameters']['userId']
        product_id = event['pathParameters']['productId']
        body = json.loads(event['body'])
        
        quantity = int(body.get('quantity', 1))
        
        if quantity <= 0:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Quantity must be greater than 0'})
            }
        
        cart_id = f"{user_id}#{product_id}"
        
        # Update TTL for 30 days from now
        ttl = int((datetime.now() + timedelta(days=30)).timestamp())
        
        # Update item quantity
        response = cart_table.update_item(
            Key={'cartId': cart_id},
            UpdateExpression='SET quantity = :quantity, updatedAt = :updatedAt, #ttl = :ttl',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':quantity': quantity,
                ':updatedAt': datetime.now().isoformat(),
                ':ttl': ttl
            },
            ConditionExpression='attribute_exists(cartId)',
            ReturnValues='ALL_NEW'
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({
                'message': 'Cart item updated',
                'cartId': cart_id,
                'quantity': quantity
            })
        }
        
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 404,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Cart item not found'})
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Remove Cart Item Lambda Function
    const removeCartItemFunction = new lambda.Function(this, 'RemoveCartItemFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        CART_TABLE_NAME: cartTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os

dynamodb = boto3.resource('dynamodb')
cart_table = dynamodb.Table(os.environ['CART_TABLE_NAME'])

def handler(event, context):
    try:
        user_id = event['pathParameters']['userId']
        product_id = event['pathParameters']['productId']
        
        cart_id = f"{user_id}#{product_id}"
        
        # Delete item from cart
        response = cart_table.delete_item(
            Key={'cartId': cart_id},
            ConditionExpression='attribute_exists(cartId)',
            ReturnValues='ALL_OLD'
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({
                'message': 'Item removed from cart',
                'cartId': cart_id
            })
        }
        
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 404,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Cart item not found'})
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // Clear Cart Lambda Function
    const clearCartFunction = new lambda.Function(this, 'ClearCartFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
      role: lambdaExecutionRole,
      environment: {
        CART_TABLE_NAME: cartTable.tableName,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os

dynamodb = boto3.resource('dynamodb')
cart_table = dynamodb.Table(os.environ['CART_TABLE_NAME'])

def handler(event, context):
    try:
        user_id = event['pathParameters']['userId']
        
        # Query all cart items for user
        response = cart_table.query(
            IndexName='UserIdIndex',
            KeyConditionExpression='userId = :userId',
            ExpressionAttributeValues={':userId': user_id}
        )
        
        cart_items = response['Items']
        
        # Delete all items
        deleted_count = 0
        with cart_table.batch_writer() as batch:
            for item in cart_items:
                batch.delete_item(Key={'cartId': item['cartId']})
                deleted_count += 1
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({
                'message': 'Cart cleared',
                'deletedItems': deleted_count
            })
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }
      `),
    });

    // CloudWatch Log Groups
    const loginLogGroup = new logs.LogGroup(this, 'LoginFunctionLogGroup', {
      logGroupName: `/aws/lambda/${loginFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda to forward CloudWatch logs to OTEL collector
    const logForwarder = new lambda.Function(this, 'LogForwarder', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/cloudwatch-to-otel')),
      environment: {
        OTEL_ENDPOINT: otelCollectorUrl,
        SERVICE_NAME: `auth-service-${cdk.Stack.of(this).account}`,
      },
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateAppSubnets,
      },
      securityGroups: [lambdaSecurityGroup],
    });

    // Subscribe log forwarder to login function logs
    new logs.SubscriptionFilter(this, 'LoginLogsToOtel', {
      logGroup: loginLogGroup,
      destination: new logs_destinations.LambdaDestination(logForwarder),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    new logs.LogGroup(this, 'RegisterFunctionLogGroup', {
      logGroupName: `/aws/lambda/${registerFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'ValidateSessionFunctionLogGroup', {
      logGroupName: `/aws/lambda/${validateSessionFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'GetCartFunctionLogGroup', {
      logGroupName: `/aws/lambda/${getCartFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'AddToCartFunctionLogGroup', {
      logGroupName: `/aws/lambda/${addToCartFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'UpdateCartItemFunctionLogGroup', {
      logGroupName: `/aws/lambda/${updateCartItemFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'RemoveCartItemFunctionLogGroup', {
      logGroupName: `/aws/lambda/${removeCartItemFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'ClearCartFunctionLogGroup', {
      logGroupName: `/aws/lambda/${clearCartFunction.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Health Check Lambda Function (no authentication required)
    const healthCheckFunction = new lambda.Function(this, 'HealthCheckFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        TABLE_NAME: userTable.tableName,
        PROJECT_NAME: props.projectName,
        ENVIRONMENT: props.environment,
      },
      code: lambda.Code.fromInline(`
import json
import boto3
import os
import time
from datetime import datetime

def handler(event, context):
    """Health check endpoint - no authentication required"""
    try:
        # Basic health check
        health_status = {
            'status': 'healthy',
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'service': 'user-auth',
            'version': '1.0.0',
            'environment': os.environ.get('ENVIRONMENT', 'unknown')
        }
        
        # Optional: Check DynamoDB connectivity
        try:
            dynamodb = boto3.resource('dynamodb')
            table = dynamodb.Table(os.environ['TABLE_NAME'])
            # Simple table description to verify connectivity
            table.table_status
            health_status['database'] = 'connected'
        except Exception as db_error:
            health_status['database'] = 'error'
            health_status['database_error'] = str(db_error)
            # Still return healthy status as this is just a connectivity check
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps(health_status)
        }
        
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'status': 'unhealthy',
                'error': str(e),
                'timestamp': datetime.utcnow().isoformat() + 'Z'
            })
        }
      `),
    });

    // Grant DynamoDB read permissions to health check function
    userTable.grantReadData(healthCheckFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, 'UserAuthAPI', {
      restApiName: `${props.projectName}-${props.environment}-user-auth-api`,
      description: 'User Authentication API',
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
      deployOptions: {
        stageName: 'v1',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
    });

    // API Gateway Resources and Methods
    const authResource = api.root.addResource('auth');

    // Login endpoint
    const loginResource = authResource.addResource('login');
    loginResource.addMethod('POST', new apigateway.LambdaIntegration(loginFunction), {
      requestValidator: new apigateway.RequestValidator(this, 'LoginRequestValidator', {
        restApi: api,
        validateRequestBody: true,
      }),
    });

    // Register endpoint
    const registerResource = authResource.addResource('register');
    registerResource.addMethod('POST', new apigateway.LambdaIntegration(registerFunction), {
      requestValidator: new apigateway.RequestValidator(this, 'RegisterRequestValidator', {
        restApi: api,
        validateRequestBody: true,
      }),
    });

    // Health endpoint (no authentication required)
    const healthResource = api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthCheckFunction), {
      authorizationType: apigateway.AuthorizationType.NONE, // No authentication required
    });

    // Validate session endpoint
    const validateResource = authResource.addResource('validate');
    const sessionResource = validateResource.addResource('{sessionId}');
    sessionResource.addMethod('GET', new apigateway.LambdaIntegration(validateSessionFunction));

    // Cart endpoints
    const cartResource = authResource.addResource('cart');
    const userCartResource = cartResource.addResource('{userId}');
    
    // GET /auth/cart/{userId} - Get user's cart
    userCartResource.addMethod('GET', new apigateway.LambdaIntegration(getCartFunction));
    
    // POST /auth/cart/{userId}/items - Add item to cart
    const cartItemsResource = userCartResource.addResource('items');
    cartItemsResource.addMethod('POST', new apigateway.LambdaIntegration(addToCartFunction), {
      requestValidator: new apigateway.RequestValidator(this, 'AddToCartRequestValidator', {
        restApi: api,
        validateRequestBody: true,
      }),
    });
    
    // PUT /auth/cart/{userId}/items/{productId} - Update cart item quantity
    const cartItemResource = cartItemsResource.addResource('{productId}');
    cartItemResource.addMethod('PUT', new apigateway.LambdaIntegration(updateCartItemFunction), {
      requestValidator: new apigateway.RequestValidator(this, 'UpdateCartItemRequestValidator', {
        restApi: api,
        validateRequestBody: true,
      }),
    });
    
    // DELETE /auth/cart/{userId}/items/{productId} - Remove item from cart
    cartItemResource.addMethod('DELETE', new apigateway.LambdaIntegration(removeCartItemFunction));
    
    // DELETE /auth/cart/{userId} - Clear cart
    userCartResource.addMethod('DELETE', new apigateway.LambdaIntegration(clearCartFunction));

    // Add CORS support for all cart endpoints
    this.addCorsOptions(userCartResource);
    this.addCorsOptions(cartItemsResource);
    this.addCorsOptions(cartItemResource);

    // SSM Parameters for cart configuration
    new cdk.aws_ssm.StringParameter(this, 'CartTTLDaysParam', {
      parameterName: `/${props.projectName}/${props.environment}/auth/cart-ttl-days`,
      stringValue: '30',
      description: 'Number of days to keep cart items before expiration',
    });

    new cdk.aws_ssm.StringParameter(this, 'MaxCartItemsParam', {
      parameterName: `/${props.projectName}/${props.environment}/auth/max-cart-items`,
      stringValue: '50',
      description: 'Maximum number of items allowed in a shopping cart',
    });

    new cdk.aws_ssm.StringParameter(this, 'CartAnalyticsEnabledParam', {
      parameterName: `/${props.projectName}/${props.environment}/auth/cart-analytics-enabled`,
      stringValue: 'true',
      description: 'Enable cart analytics and metrics collection',
    });

    // Set outputs
    this.apiGatewayUrl = api.url;
    this.lambdaExecutionRoleArn = lambdaExecutionRole.roleArn;

    // CloudWatch Alarms
    // Lambda Error Rate
    const functions = [loginFunction, registerFunction, validateSessionFunction, getCartFunction, addToCartFunction, updateCartItemFunction, removeCartItemFunction, clearCartFunction];
    functions.forEach((func) => {
      new cloudwatch.Alarm(this, `${func.node.id}ErrorRate`, {
        alarmName: `${props.projectName}-${props.environment}-${func.node.id}-error-rate`,
        metric: func.metricErrors(),
        threshold: 5,
        evaluationPeriods: 2,
        alarmDescription: `${func.node.id} error rate is high`,
      });

      new cloudwatch.Alarm(this, `${func.node.id}Duration`, {
        alarmName: `${props.projectName}-${props.environment}-${func.node.id}-duration`,
        metric: func.metricDuration(),
        threshold: 10000, // 10 seconds
        evaluationPeriods: 2,
        alarmDescription: `${func.node.id} duration is high`,
      });
    });

    // DynamoDB Throttling Alarms
    [userTable, sessionTable, cartTable].forEach((table, index) => {
      const tableName = ['User', 'Session', 'Cart'][index];
      
      new cloudwatch.Alarm(this, `${tableName}TableReadThrottles`, {
        alarmName: `${props.projectName}-${props.environment}-${tableName.toLowerCase()}-read-throttles`,
        metric: table.metricUserErrors(),
        threshold: 1,
        evaluationPeriods: 2,
        alarmDescription: `${tableName} table read throttling detected`,
      });

      new cloudwatch.Alarm(this, `${tableName}TableHighReadCapacity`, {
        alarmName: `${props.projectName}-${props.environment}-${tableName.toLowerCase()}-high-read-capacity`,
        metric: table.metricConsumedReadCapacityUnits(),
        threshold: 80,
        evaluationPeriods: 2,
        alarmDescription: `${tableName} table high read capacity consumption`,
      });
    });

    // API Gateway Alarms
    new cloudwatch.Alarm(this, 'APIGateway4XXErrors', {
      alarmName: `${props.projectName}-${props.environment}-auth-api-4xx-errors`,
      metric: api.metricClientError(),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'Auth API 4XX error rate is high',
    });

    new cloudwatch.Alarm(this, 'APIGateway5XXErrors', {
      alarmName: `${props.projectName}-${props.environment}-auth-api-5xx-errors`,
      metric: api.metricServerError(),
      threshold: 5,
      evaluationPeriods: 2,
      alarmDescription: 'Auth API 5XX error rate is high',
    });

    // Dashboard
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.projectName}-${props.environment}-user-auth`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'API Gateway Metrics',
            left: [api.metricCount(), api.metricLatency()],
            right: [api.metricClientError(), api.metricServerError()],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda Invocations',
            left: functions.map(f => f.metricInvocations()),
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda Errors',
            left: functions.map(f => f.metricErrors()),
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'DynamoDB Consumed Capacity',
            left: [userTable, sessionTable, cartTable].map(t => t.metricConsumedReadCapacityUnits()),
            right: [userTable, sessionTable, cartTable].map(t => t.metricConsumedWriteCapacityUnits()),
            width: 12,
          }),
        ],
      ],
    });

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'UserAuthentication');
  }

  private addCorsOptions(resource: apigateway.Resource) {
    resource.addMethod('OPTIONS', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
          'method.response.header.Access-Control-Allow-Origin': "'*'",
          'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'"
        },
      }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: {
        'application/json': '{"statusCode": 200}'
      },
    }), {
      methodResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Headers': true,
          'method.response.header.Access-Control-Allow-Methods': true,
          'method.response.header.Access-Control-Allow-Origin': true,
        },
      }]
    });
  }
}
