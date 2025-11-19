import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface GitLabStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  availabilityZones?: string[];
}

export class GitLabStack extends cdk.Stack {
  public readonly instanceId: string;
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: GitLabStackProps) {
    super(scope, id, props);

    const availabilityZones = (props.availabilityZones || this.availabilityZones).slice(0, 3);

    // Import VPC from SharedInfra stack
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'VPC', {
      vpcId: cdk.Fn.importValue('shopsmart-prod-VpcId'),
      availabilityZones,
      publicSubnetIds: [
        cdk.Fn.importValue('shopsmart-prod-PublicSubnet1Id'),
        cdk.Fn.importValue('shopsmart-prod-PublicSubnet2Id'),
        cdk.Fn.importValue('shopsmart-prod-PublicSubnet3Id')
      ]
    });

    // Security Group for GitLab
    const gitlabSG = new ec2.SecurityGroup(this, 'GitLabSecurityGroup', {
      vpc,
      description: 'Security group for GitLab CE',
      allowAllOutbound: true
    });

    gitlabSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    gitlabSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    gitlabSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');

    // IAM Role for GitLab instance
    const gitlabRole = new iam.Role(this, 'GitLabRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // Key Pair for SSH access
    const keyPair = new ec2.KeyPair(this, 'GitLabKeyPair', {
      keyPairName: 'gitlab-keypair',
      type: ec2.KeyPairType.RSA,
      format: ec2.KeyPairFormat.PEM
    });

    // User data to install Python 3.8
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'yum update -y',
      'amazon-linux-extras install python3.8 -y'
    );

    // GitLab EC2 Instance (infrastructure only)
    const gitlabInstance = new ec2.Instance(this, 'GitLabInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: gitlabSG,
      role: gitlabRole,
      keyPair: keyPair,
      userData: userData,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });

    this.instanceId = gitlabInstance.instanceId;
    this.publicIp = gitlabInstance.instancePublicIp;

    // Outputs
    new cdk.CfnOutput(this, 'GitLabInstanceId', {
      value: gitlabInstance.instanceId,
      description: 'GitLab EC2 Instance ID'
    });

    new cdk.CfnOutput(this, 'GitLabPublicIP', {
      value: gitlabInstance.instancePublicIp,
      description: 'GitLab EC2 Public IP'
    });

    new cdk.CfnOutput(this, 'GitLabKeyPairName', {
      value: keyPair.keyPairName,
      description: 'GitLab SSH Key Pair Name'
    });

    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `ssh -i ~/.ssh/gitlab-keypair.pem ec2-user@${gitlabInstance.instancePublicIp}`,
      description: 'SSH command to connect to GitLab instance'
    });
  }
}
