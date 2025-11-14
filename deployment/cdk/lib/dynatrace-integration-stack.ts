import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DynatraceConstruct } from './constructs/dynatrace-construct';

interface DynatraceIntegrationStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  vpcId: string;
}

export class DynatraceIntegrationStack extends cdk.Stack {
  public readonly dynatraceConstruct: DynatraceConstruct;

  constructor(scope: Construct, id: string, props: DynatraceIntegrationStackProps) {
    super(scope, id, props);

    // Import VPC
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      vpcId: props.vpcId
    });

    // Create Dynatrace construct
    this.dynatraceConstruct = new DynatraceConstruct(this, 'DynatraceConstruct', {
      vpc
    });

    // IAM role for instances to access Dynatrace parameters
    const dynatraceRole = new iam.Role(this, 'DynatraceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // Grant access to Dynatrace SSM parameters
    dynatraceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/dynatrace/*`
      ]
    }));

    // Output the role ARN for use in other stacks
    new cdk.CfnOutput(this, 'DynatraceRoleArn', {
      value: dynatraceRole.roleArn,
      exportName: `${props.projectName}-${props.environment}-DynatraceRoleArn`
    });
  }
}
