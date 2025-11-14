#!/bin/bash
set -e

REGION="us-west-2"

# Dynamically discover API Gateway endpoint from CloudFormation
echo "Discovering API Gateway endpoint..."
API_ENDPOINT=$(aws cloudformation describe-stacks --region "$REGION" --stack-name ShopSmart-ApiGatewayRouter-v2 --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayRouterEndpoint`].OutputValue' --output text 2>/dev/null)

if [ -z "$API_ENDPOINT" ]; then
    echo "Error: Could not find API Gateway endpoint from CloudFormation"
    echo "Falling back to manual discovery..."
    API_ENDPOINT="http://shopsmart-prod-v2-api-gateway-989395160.us-west-2.elb.amazonaws.com"
fi

echo "Using API endpoint: $API_ENDPOINT"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}ShopSmart Failure Simulation Script${NC}"
echo "======================================"
echo ""
echo "Available scenarios:"
echo "1) Order traffic spike (high latency & dropped orders)"
echo "2) Break auth service (configuration change)"
echo "3) Restore auth service"
echo ""

read -p "Select scenario (1-3): " scenario

case $scenario in
  1)
    echo -e "\n${YELLOW}Simulating INTENSE order traffic spike...${NC}"
    echo "This will generate 5 waves of 100 concurrent requests (500 total)"
    read -p "Continue? (y/n): " confirm
    
    if [ "$confirm" != "y" ]; then
      echo "Cancelled"
      exit 0
    fi
    
    # Generate order payload
    ORDER_JSON='{"user_id":"load-test-user","items":[{"product_id":"desk-spike","name":"Load Test Desk","price":1000.00,"quantity":1,"crafting_time_months":1,"artisan_name":"Test","material":"Oak","style":"Modern"}],"shipping_address":{"street":"123 Test St","city":"Seattle","state":"WA","zip_code":"98101","country":"US"}}'
    
    SUCCESS=0
    FAILED=0
    TOTAL_DURATION=0
    
    echo "Starting traffic spike at $(date)"
    
    # Launch 5 waves in parallel
    for wave in {1..20}; do
      (
        echo -e "${YELLOW}Wave $wave starting...${NC}"
        for i in {1..1000}; do
          (
            START=$(date +%s%N)
            HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_ENDPOINT/orders" \
              -H "Content-Type: application/json" \
              -d "$ORDER_JSON" 2>&1)
            END=$(date +%s%N)
            DURATION=$(( (END - START) / 1000000 ))
            
            if [ "$HTTP_CODE" = "201" ]; then
              echo "$DURATION SUCCESS"
            else
              echo "$DURATION FAILED $HTTP_CODE"
            fi
          ) &
        done
        wait
        echo -e "${GREEN}Wave $wave complete${NC}"
      ) &
    done
    
    wait
    
    echo -e "\n${GREEN}Traffic spike complete at $(date)${NC}"
    echo "Check CloudWatch metrics and Dynatrace for impact"
    ;;
    
  2)
    echo -e "\n${YELLOW}Breaking auth service...${NC}"
    echo "Setting invalid DynamoDB table name"
    
    # Get current Lambda function name (just the login function)
    LAMBDA_NAME=$(aws lambda list-functions --region $REGION \
      --query 'Functions[?contains(FunctionName, `UserAuthLogin`)].FunctionName' \
      --output text)
    
    if [ -z "$LAMBDA_NAME" ]; then
      echo -e "${RED}Error: Could not find UserAuth Login Lambda function${NC}"
      exit 1
    fi
    
    echo "Found Lambda: $LAMBDA_NAME"
    
    # Get current environment variables to preserve them (especially OTEL config)
    CURRENT_ENV=$(aws lambda get-function-configuration \
      --function-name "$LAMBDA_NAME" \
      --region $REGION \
      --query 'Environment.Variables' \
      --output json)
    
    # Update only USER_TABLE_NAME, preserve everything else including OTEL variables
    UPDATED_ENV=$(echo "$CURRENT_ENV" | jq -c '.USER_TABLE_NAME = "invalid-table-name-does-not-exist"')
    
    aws lambda update-function-configuration \
      --function-name "$LAMBDA_NAME" \
      --environment "{\"Variables\":$UPDATED_ENV}" \
      --region $REGION > /dev/null
    
    echo -e "${RED}Auth service broken! All auth requests will fail.${NC}"
    echo "Test with: curl $API_ENDPOINT/api/auth/login"
    ;;
    
  3)
    echo -e "\n${YELLOW}Restoring auth service...${NC}"
    
    # Get Lambda function name
    LAMBDA_NAME=$(aws lambda list-functions --region $REGION \
      --query 'Functions[?contains(FunctionName, `UserAuthLogin`)].FunctionName' \
      --output text)
    
    if [ -z "$LAMBDA_NAME" ]; then
      echo -e "${RED}Error: Could not find UserAuth Lambda function${NC}"
      exit 1
    fi
    
    # Get correct table names from DynamoDB
    USER_TABLE=$(aws dynamodb list-tables --region $REGION \
      --query 'TableNames[?contains(@, `user`) || contains(@, `User`)]' \
      --output text)
    
    SESSION_TABLE=$(aws dynamodb list-tables --region $REGION \
      --query 'TableNames[?contains(@, `session`) || contains(@, `Session`)]' \
      --output text)
    
    if [ -z "$USER_TABLE" ] || [ -z "$SESSION_TABLE" ]; then
      echo -e "${RED}Error: Could not find required tables${NC}"
      exit 1
    fi
    
    echo "Restoring table names:"
    echo "  USER_TABLE_NAME: $USER_TABLE"
    echo "  SESSION_TABLE_NAME: $SESSION_TABLE"
    
    # Get current environment variables to preserve them (especially OTEL config)
    CURRENT_ENV=$(aws lambda get-function-configuration \
      --function-name "$LAMBDA_NAME" \
      --region $REGION \
      --query 'Environment.Variables' \
      --output json)
    
    # Update only the table names, preserve everything else including OTEL variables
    UPDATED_ENV=$(echo "$CURRENT_ENV" | jq -c --arg user "$USER_TABLE" --arg session "$SESSION_TABLE" \
      '.USER_TABLE_NAME = $user | .SESSION_TABLE_NAME = $session')
    
    # Restore correct environment variables
    aws lambda update-function-configuration \
      --function-name "$LAMBDA_NAME" \
      --environment "{\"Variables\":$UPDATED_ENV}" \
      --region $REGION > /dev/null
    
    echo -e "${GREEN}Auth service restored!${NC}"
    ;;
    
  *)
    echo -e "${RED}Invalid scenario selected${NC}"
    exit 1
    ;;
esac
