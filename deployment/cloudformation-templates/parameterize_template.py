#!/usr/bin/env python3
"""
Convert CDK-synthesized CloudFormation template to parameterized, portable version
"""
import yaml
import sys
import re

def parameterize_template(input_file, output_file):
    """Convert hardcoded values to parameters"""
    
    with open(input_file, 'r') as f:
        template = yaml.safe_load(f)
    
    # Add Parameters section
    template['Parameters'] = {
        'Environment': {
            'Type': 'String',
            'Default': 'prod',
            'AllowedValues': ['dev', 'staging', 'prod'],
            'Description': 'Environment name'
        },
        'ProjectName': {
            'Type': 'String',
            'Default': 'shopsmart',
            'Description': 'Project name for resource naming'
        },
        'VpcId': {
            'Type': 'AWS::EC2::VPC::Id',
            'Description': 'VPC ID for Lambda functions'
        },
        'PrivateSubnet1Id': {
            'Type': 'AWS::EC2::Subnet::Id',
            'Description': 'Private subnet 1 ID'
        },
        'PrivateSubnet2Id': {
            'Type': 'AWS::EC2::Subnet::Id',
            'Description': 'Private subnet 2 ID'
        },
        'PrivateSubnet3Id': {
            'Type': 'AWS::EC2::Subnet::Id',
            'Description': 'Private subnet 3 ID'
        },
        'DynatraceEndpoint': {
            'Type': 'String',
            'Default': '',
            'Description': 'Dynatrace OpenTelemetry endpoint (optional)'
        },
        'DynatraceApiToken': {
            'Type': 'String',
            'Default': '',
            'NoEcho': True,
            'Description': 'Dynatrace API token (optional)'
        }
    }
    
    # Convert template to string for regex replacements
    template_str = yaml.dump(template, default_flow_style=False, sort_keys=False)
    
    # Replace hardcoded values with parameter references
    replacements = [
        (r'shopsmart-prod-', '!Sub ${ProjectName}-${Environment}-'),
        (r'prod(?=["\s,}])', '!Ref Environment'),
        (r'Fn::ImportValue: shopsmart-prod-VpcId', '!Ref VpcId'),
        (r'Fn::ImportValue: shopsmart-prod-PrivateAppSubnet1Id', '!Ref PrivateSubnet1Id'),
        (r'Fn::ImportValue: shopsmart-prod-PrivateAppSubnet2Id', '!Ref PrivateSubnet2Id'),
        (r'Fn::ImportValue: shopsmart-prod-PrivateAppSubnet3Id', '!Ref PrivateSubnet3Id'),
    ]
    
    for pattern, replacement in replacements:
        template_str = re.sub(pattern, replacement, template_str)
    
    # Remove CDK metadata
    template_reloaded = yaml.safe_load(template_str)
    if 'Metadata' in template_reloaded:
        # Keep only AWS::CloudFormation::Interface if it exists
        if 'AWS::CloudFormation::Interface' in template_reloaded.get('Metadata', {}):
            template_reloaded['Metadata'] = {
                'AWS::CloudFormation::Interface': template_reloaded['Metadata']['AWS::CloudFormation::Interface']
            }
        else:
            del template_reloaded['Metadata']
    
    # Remove CDK-specific resources
    resources_to_remove = []
    for resource_name, resource in template_reloaded.get('Resources', {}).items():
        if resource.get('Type') == 'AWS::CDK::Metadata':
            resources_to_remove.append(resource_name)
    
    for resource_name in resources_to_remove:
        del template_reloaded['Resources'][resource_name]
    
    # Write output
    with open(output_file, 'w') as f:
        f.write('# Parameterized CloudFormation Template\n')
        f.write('# Generated from CDK synthesis\n')
        f.write('# \n')
        f.write('# Usage:\n')
        f.write('#   aws cloudformation create-stack \\\n')
        f.write('#     --stack-name shopsmart-userauth \\\n')
        f.write('#     --template-body file://userauth-template.yaml \\\n')
        f.write('#     --parameters \\\n')
        f.write('#       ParameterKey=Environment,ParameterValue=prod \\\n')
        f.write('#       ParameterKey=VpcId,ParameterValue=vpc-xxx \\\n')
        f.write('#       ParameterKey=PrivateSubnet1Id,ParameterValue=subnet-xxx \\\n')
        f.write('#     --capabilities CAPABILITY_IAM\n')
        f.write('# \n\n')
        yaml.dump(template_reloaded, f, default_flow_style=False, sort_keys=False)
    
    print(f"✓ Parameterized template written to {output_file}")
    print(f"  Original resources: {len(template.get('Resources', {}))}")
    print(f"  Final resources: {len(template_reloaded.get('Resources', {}))}")
    print(f"  Parameters added: {len(template_reloaded.get('Parameters', {}))}")

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python parameterize_template.py <input.yaml> <output.yaml>")
        sys.exit(1)
    
    parameterize_template(sys.argv[1], sys.argv[2])
