#!/bin/bash

# Product Catalog Service Installation Script for EC2
# This script installs and configures the product catalog service on EC2 instances

set -e

# Configuration
SERVICE_NAME="product-catalog"
SERVICE_USER="catalog"
SERVICE_DIR="/opt/product-catalog"
LOG_DIR="/var/log/product-catalog"
PYTHON_VERSION="3.11"

echo "Starting Product Catalog Service installation..."

# Update system packages
echo "Updating system packages..."
sudo yum update -y

# Install Python 3.11 and development tools
echo "Installing Python ${PYTHON_VERSION} and development tools..."
sudo yum install -y python3.11 python3.11-pip python3.11-devel
sudo yum install -y gcc postgresql-devel redis-tools

# Create service user
echo "Creating service user..."
if ! id "$SERVICE_USER" &>/dev/null; then
    sudo useradd -r -s /bin/false -d "$SERVICE_DIR" "$SERVICE_USER"
fi

# Create directories
echo "Creating service directories..."
sudo mkdir -p "$SERVICE_DIR"
sudo mkdir -p "$LOG_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"

# Install application files
echo "Installing application files..."
sudo cp -r /tmp/product-catalog/* "$SERVICE_DIR/"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_DIR"

# Install Python dependencies
echo "Installing Python dependencies..."
cd "$SERVICE_DIR"
sudo -u "$SERVICE_USER" python3.11 -m pip install --user -r requirements.txt

# Install CloudWatch agent
echo "Installing CloudWatch agent..."
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
sudo rpm -U ./amazon-cloudwatch-agent.rpm
rm -f ./amazon-cloudwatch-agent.rpm

# Create CloudWatch agent configuration
sudo tee /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json > /dev/null <<EOF
{
    "agent": {
        "metrics_collection_interval": 60,
        "run_as_user": "cwagent"
    },
    "logs": {
        "logs_collected": {
            "files": {
                "collect_list": [
                    {
                        "file_path": "${LOG_DIR}/app.log",
                        "log_group_name": "/aws/ec2/product-catalog",
                        "log_stream_name": "{instance_id}/app.log",
                        "timezone": "UTC",
                        "timestamp_format": "%Y-%m-%d %H:%M:%S"
                    },
                    {
                        "file_path": "${LOG_DIR}/access.log",
                        "log_group_name": "/aws/ec2/product-catalog",
                        "log_stream_name": "{instance_id}/access.log",
                        "timezone": "UTC"
                    }
                ]
            }
        }
    },
    "metrics": {
        "namespace": "ShopSmart/ProductCatalog/EC2",
        "metrics_collected": {
            "cpu": {
                "measurement": [
                    "cpu_usage_idle",
                    "cpu_usage_iowait",
                    "cpu_usage_user",
                    "cpu_usage_system"
                ],
                "metrics_collection_interval": 60,
                "totalcpu": false
            },
            "disk": {
                "measurement": [
                    "used_percent"
                ],
                "metrics_collection_interval": 60,
                "resources": [
                    "*"
                ]
            },
            "diskio": {
                "measurement": [
                    "io_time"
                ],
                "metrics_collection_interval": 60,
                "resources": [
                    "*"
                ]
            },
            "mem": {
                "measurement": [
                    "mem_used_percent"
                ],
                "metrics_collection_interval": 60
            },
            "netstat": {
                "measurement": [
                    "tcp_established",
                    "tcp_time_wait"
                ],
                "metrics_collection_interval": 60
            },
            "swap": {
                "measurement": [
                    "swap_used_percent"
                ],
                "metrics_collection_interval": 60
            }
        }
    }
}
EOF

# Start CloudWatch agent
echo "Starting CloudWatch agent..."
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Create systemd service file
echo "Creating systemd service..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Product Catalog Service
After=network.target

[Service]
Type=exec
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${SERVICE_DIR}
Environment=PATH=/home/${SERVICE_USER}/.local/bin:\$PATH
ExecStart=/usr/bin/python3.11 -m uvicorn app:app --host 0.0.0.0 --port 80 --workers 4
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/app.log

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SERVICE_DIR} ${LOG_DIR}

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}

# Create log rotation configuration
echo "Setting up log rotation..."
sudo tee /etc/logrotate.d/${SERVICE_NAME} > /dev/null <<EOF
${LOG_DIR}/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 ${SERVICE_USER} ${SERVICE_USER}
    postrotate
        systemctl reload ${SERVICE_NAME} > /dev/null 2>&1 || true
    endscript
}
EOF

echo "Product Catalog Service installation completed!"
echo "To start the service: sudo systemctl start ${SERVICE_NAME}"
echo "To check status: sudo systemctl status ${SERVICE_NAME}"
echo "To view logs: sudo journalctl -u ${SERVICE_NAME} -f"