import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface OrderProcessingConstructProps {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateAppSubnets: ec2.ISubnet[];
  availabilityZones: string[];
  projectName: string;
  environment: string;
  eksNodeInstanceType: string;
  eksMinNodes: number;
  eksMaxNodes: number;
  eksDesiredNodes: number;
  mongodbCpuLimit: string;
  mongodbMemoryLimit: string;
  mongodbStorageSize: string;
}

export class OrderProcessingConstruct extends Construct {
  public readonly eksClusterName: string;
  public readonly eksRoleArn: string;

  constructor(scope: Construct, id: string, props: OrderProcessingConstructProps) {
    super(scope, id);

    // KMS Key for EKS cluster encryption
    const eksKmsKey = new kms.Key(this, 'EKSKMSKey', {
      description: 'KMS key for EKS cluster encryption',
      enableKeyRotation: true,
    });

    // EKS Cluster Service Role
    const clusterRole = new iam.Role(this, 'EKSClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
      ],
    });

    // EKS Node Group Role
    const nodeGroupRole = new iam.Role(this, 'EKSNodeGroupRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // EKS Cluster with updated configuration to avoid Python 3.7 issues
    const cluster = new eks.Cluster(this, 'EKSCluster', {
      clusterName: `${props.projectName}-${props.environment}-order-processing`,
      version: eks.KubernetesVersion.V1_28, // Updated to newer version
      role: clusterRole,
      vpc: props.vpc,
      vpcSubnets: [
        {
          subnets: props.privateAppSubnets,
        },
      ],
      endpointAccess: eks.EndpointAccess.PRIVATE,
      secretsEncryptionKey: eksKmsKey,
      defaultCapacity: 0, // We'll add managed node groups separately
      // The newer CDK version should handle kubectl layer automatically
    });

    // Managed Node Group
    const nodeGroup = cluster.addNodegroupCapacity('DefaultNodeGroup', {
      instanceTypes: [new ec2.InstanceType(props.eksNodeInstanceType)], // Deliberately oversized as per architecture doc
      minSize: props.eksMinNodes,
      maxSize: props.eksMaxNodes,
      desiredSize: props.eksDesiredNodes,
      subnets: {
        subnets: props.privateAppSubnets,
      },
      nodeRole: nodeGroupRole,
      amiType: eks.NodegroupAmiType.AL2_X86_64,
      capacityType: eks.CapacityType.ON_DEMAND,
      diskSize: 100,
      forceUpdate: false,
      labels: {
        'node-type': 'application',
        'service': 'order-processing',
      },
      taints: [],
    });

    // MongoDB Namespace
    const mongodbNamespace = cluster.addManifest('MongoDBNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'mongodb',
        labels: {
          name: 'mongodb',
        },
      },
    });

    // MongoDB ConfigMap
    const mongodbConfigMap = cluster.addManifest('MongoDBConfigMap', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'mongodb-config',
        namespace: 'mongodb',
      },
      data: {
        'mongod.conf': `
storage:
  dbPath: /data/db
  journal:
    enabled: true
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 0.0.0.0
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
        `,
      },
    });

    mongodbConfigMap.node.addDependency(mongodbNamespace);

    // MongoDB Secret
    const mongodbSecret = cluster.addManifest('MongoDBSecret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'mongodb-secret',
        namespace: 'mongodb',
      },
      type: 'Opaque',
      data: {
        'mongodb-root-username': Buffer.from('admin').toString('base64'),
        'mongodb-root-password': Buffer.from('Password123!').toString('base64'), // This would be replaced with a proper secret in production
      },
    });

    mongodbSecret.node.addDependency(mongodbNamespace);

    // MongoDB PersistentVolumeClaim
    const mongodbPVC = cluster.addManifest('MongoDBPVC', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'mongodb-pvc',
        namespace: 'mongodb',
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: props.mongodbStorageSize, // Deliberately oversized as per architecture doc
          },
        },
        storageClassName: 'gp2',
      },
    });

    mongodbPVC.node.addDependency(mongodbNamespace);

    // MongoDB Deployment
    const mongodbDeployment = cluster.addManifest('MongoDBDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'mongodb',
        namespace: 'mongodb',
        labels: {
          app: 'mongodb',
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'mongodb',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'mongodb',
            },
          },
          spec: {
            containers: [
              {
                name: 'mongodb',
                image: 'mongo:6.0',
                ports: [
                  {
                    containerPort: 27017,
                  },
                ],
                env: [
                  {
                    name: 'MONGO_INITDB_ROOT_USERNAME',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'mongodb-secret',
                        key: 'mongodb-root-username',
                      },
                    },
                  },
                  {
                    name: 'MONGO_INITDB_ROOT_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'mongodb-secret',
                        key: 'mongodb-root-password',
                      },
                    },
                  },
                ],
                resources: {
                  requests: {
                    cpu: props.mongodbCpuLimit, // Deliberately oversized as per architecture doc
                    memory: props.mongodbMemoryLimit, // Deliberately oversized as per architecture doc
                  },
                  limits: {
                    cpu: props.mongodbCpuLimit,
                    memory: props.mongodbMemoryLimit,
                  },
                },
                volumeMounts: [
                  {
                    name: 'mongodb-storage',
                    mountPath: '/data/db',
                  },
                  {
                    name: 'mongodb-config',
                    mountPath: '/etc/mongod.conf',
                    subPath: 'mongod.conf',
                  },
                ],
                livenessProbe: {
                  exec: {
                    command: ['mongo', '--eval', 'db.adminCommand("ping")'],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 6,
                },
                readinessProbe: {
                  exec: {
                    command: ['mongo', '--eval', 'db.adminCommand("ping")'],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 6,
                },
              },
            ],
            volumes: [
              {
                name: 'mongodb-storage',
                persistentVolumeClaim: {
                  claimName: 'mongodb-pvc',
                },
              },
              {
                name: 'mongodb-config',
                configMap: {
                  name: 'mongodb-config',
                },
              },
            ],
          },
        },
      },
    });

    mongodbDeployment.node.addDependency(mongodbSecret);
    mongodbDeployment.node.addDependency(mongodbConfigMap);
    mongodbDeployment.node.addDependency(mongodbPVC);

    // MongoDB Service
    const mongodbService = cluster.addManifest('MongoDBService', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'mongodb-service',
        namespace: 'mongodb',
        labels: {
          app: 'mongodb',
        },
      },
      spec: {
        selector: {
          app: 'mongodb',
        },
        ports: [
          {
            port: 27017,
            targetPort: 27017,
            protocol: 'TCP',
          },
        ],
        type: 'ClusterIP',
      },
    });

    mongodbService.node.addDependency(mongodbDeployment);

    // Order Processing Application Namespace
    const appNamespace = cluster.addManifest('OrderProcessingNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'order-processing',
        labels: {
          name: 'order-processing',
        },
      },
    });

    // Read OpenTelemetry Collector endpoint from SSM Parameter Store
    const otelCollectorUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.projectName}/${props.environment}/opentelemetry/collector-url`
    );

    // Order Processing Application Deployment (placeholder)
    const appDeployment = cluster.addManifest('OrderProcessingDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'order-processing-app',
        namespace: 'order-processing',
        labels: {
          app: 'order-processing-app',
        },
      },
      spec: {
        replicas: 3,
        selector: {
          matchLabels: {
            app: 'order-processing-app',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'order-processing-app',
            },
          },
          spec: {
            containers: [
              {
                name: 'order-processing',
                image: 'nginx:latest', // Placeholder image
                ports: [
                  {
                    containerPort: 80,
                  },
                ],
                env: [
                  {
                    name: 'MONGODB_URI',
                    value: 'mongodb://mongodb-service.mongodb.svc.cluster.local:27017',
                  },
                  {
                    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
                    value: otelCollectorUrl,
                  },
                  {
                    name: 'OTEL_EXPORTER_OTLP_PROTOCOL',
                    value: 'http/protobuf',
                  },
                  {
                    name: 'OTEL_SERVICE_NAME',
                    value: `order-processing-service-${cdk.Stack.of(this).account}`,
                  },
                  {
                    name: 'OTEL_RESOURCE_ATTRIBUTES',
                    value: `service.name=order-processing-service-${cdk.Stack.of(this).account},service.version=1.0.0,deployment.environment=${props.environment}`,
                  },
                ],
                resources: {
                  requests: {
                    cpu: '100m',
                    memory: '128Mi',
                  },
                  limits: {
                    cpu: '500m',
                    memory: '512Mi',
                  },
                },
              },
            ],
          },
        },
      },
    });

    appDeployment.node.addDependency(appNamespace);
    appDeployment.node.addDependency(mongodbService);

    // Order Processing Service
    const appService = cluster.addManifest('OrderProcessingService', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'order-processing-service',
        namespace: 'order-processing',
        labels: {
          app: 'order-processing-app',
        },
      },
      spec: {
        selector: {
          app: 'order-processing-app',
        },
        ports: [
          {
            port: 80,
            targetPort: 80,
            protocol: 'TCP',
          },
        ],
        type: 'LoadBalancer',
        annotations: {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
          'service.beta.kubernetes.io/aws-load-balancer-internal': 'true',
        },
      },
    });

    appService.node.addDependency(appDeployment);

    // Set outputs
    this.eksClusterName = cluster.clusterName;
    this.eksRoleArn = clusterRole.roleArn;

    // Add tags
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Service', 'OrderProcessing');
  }
}
