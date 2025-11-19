FROM public.ecr.aws/amazonlinux/amazonlinux:2

# Install PostgreSQL client, Python 3, AWS CLI, and dependencies
RUN yum update -y && \
    amazon-linux-extras install postgresql14 -y && \
    yum install -y python3 python3-pip jq unzip && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip && \
    yum clean all

# Copy all database scripts
COPY database /app/database

# Set working directory
WORKDIR /app/database

# Install Python dependencies
RUN pip3 install --no-cache-dir -r postgresql/requirements.txt && \
    pip3 install --no-cache-dir -r dynamodb/requirements.txt

# Make shell scripts executable
RUN chmod +x seed_all.sh postgresql/migrate.sh

# Use bash to run the script directly
ENTRYPOINT ["/bin/bash"]
CMD ["/app/database/seed_all.sh"]
