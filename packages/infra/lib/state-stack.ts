import { Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { bundle } from './bundle.ts';
import { settings } from './props.ts';

/** State (DynamoDB, transcript bucket), secrets, and the token vendor. */
export class StateStack extends Stack {
  readonly table: dynamodb.Table;
  readonly transcriptBucket: s3.Bucket;
  readonly transcriptKey: kms.Key;
  readonly webhookSecret: secrets.Secret;
  readonly appKeySecret: secrets.Secret;
  readonly swampKeySecret: secrets.Secret;
  readonly claudeTokenSecret: secrets.Secret;
  readonly tokenVendor: lambda.Function;
  readonly alarmTopic?: sns.Topic;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const cfg = settings(this);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.transcriptKey = new kms.Key(this, 'TranscriptKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    this.transcriptBucket = new s3.Bucket(this, 'Transcripts', {
      versioned: true, encryption: s3.BucketEncryption.KMS, encryptionKey: this.transcriptKey, bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), expiration: Duration.days(365), abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });

    // Empty placeholders: the real values are loaded with `aws secretsmanager put-secret-value` (see docs/github-app.md).
    this.webhookSecret = new secrets.Secret(this, 'WebhookSecret', { secretName: 'ai-developer-agent/github-webhook-secret', removalPolicy: RemovalPolicy.RETAIN });
    this.appKeySecret = new secrets.Secret(this, 'AppKeySecret', { secretName: 'ai-developer-agent/github-app-private-key', removalPolicy: RemovalPolicy.RETAIN });

    // A swamp-club.com collective token. The swamp CLI refuses to run without one. "UNSET" means not configured: the agent then skips the factory.
    this.swampKeySecret = new secrets.Secret(this, 'SwampKeySecret', {
      secretName: 'ai-developer-agent/swamp-api-key', secretStringValue: SecretValue.unsafePlainText('UNSET'), removalPolicy: RemovalPolicy.RETAIN,
    });

    // A Claude subscription token from `claude setup-token`, used only when the agent-backend SSM parameter is claude-code. "UNSET" means not configured:
    // the Claude Code backend then refuses to run and does not fall back to Bedrock.
    this.claudeTokenSecret = new secrets.Secret(this, 'ClaudeTokenSecret', {
      secretName: 'ai-developer-agent/claude-code-oauth-token', secretStringValue: SecretValue.unsafePlainText('UNSET'), removalPolicy: RemovalPolicy.RETAIN,
    });

    this.tokenVendor = new lambda.Function(this, 'TokenVendor', {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(bundle('token-vendor', 'packages/token-vendor/src/index.ts')),
      timeout: Duration.seconds(20), memorySize: 256,
      environment: { APP_KEY_SECRET_ARN: this.appKeySecret.secretArn, GITHUB_APP_ID: cfg.githubAppId },
    });
    // Only the token vendor can read the App private key.
    this.appKeySecret.grantRead(this.tokenVendor);

    if (cfg.alarmEmail) {
      this.alarmTopic = new sns.Topic(this, 'Alarms');
      this.alarmTopic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
    }
  }
}
