import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { bundle, bundleSegmentImage } from './bundle.ts';
import { settings } from './props.ts';
import type { StateStack } from './state-stack.ts';

export const IMAGE_VERSION_PARAM = '/ai-developer-agent/microvm-image-version';

export interface SandboxProps extends StackProps { state: StateStack }

const lambdaServicePrincipal = (stack: Stack) => new iam.ServicePrincipal('lambda.amazonaws.com', {
  conditions: { StringEquals: { 'aws:SourceAccount': stack.account } },
});

/** MicroVM image, the segment execution role, and the orphan sweeper. */
export class SandboxStack extends Stack {
  readonly image: lambda.CfnMicrovmImage;
  readonly segmentRole: iam.Role;
  readonly sweeper: lambda.Function;

  constructor(scope: Construct, id: string, props: SandboxProps) {
    super(scope, id, props);
    const cfg = settings(this);
    const { state } = props;

    const logGroup = new logs.LogGroup(this, 'SegmentLogs', { retention: logs.RetentionDays.ONE_MONTH });

    // Build role: reads the artifact and writes build logs.
    const artifact = new s3assets.Asset(this, 'SegmentArtifact', { path: bundleSegmentImage() });
    const buildRole = new iam.Role(this, 'ImageBuildRole', { assumedBy: lambdaServicePrincipal(this) });
    buildRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession'], principals: [lambdaServicePrincipal(this)],
    }));
    artifact.grantRead(buildRole);
    logGroup.grantWrite(buildRole);
    buildRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup'], resources: ['*'] }));

    // Execution role of every segment MicroVM. Note: the orchestrator stack adds the durable callback permissions.
    this.segmentRole = new iam.Role(this, 'SegmentRole', { assumedBy: lambdaServicePrincipal(this) });
    this.segmentRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:TagSession'], principals: [lambdaServicePrincipal(this)],
    }));
    logGroup.grantWrite(this.segmentRole);
    state.table.grant(this.segmentRole, 'dynamodb:GetItem', 'dynamodb:Query'); // read inbox MSG items only
    state.transcriptBucket.grantReadWrite(this.segmentRole);
    state.tokenVendor.grantInvoke(this.segmentRole);
    state.swampKeySecret.grantRead(this.segmentRole);
    this.segmentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*anthropic.*`,
      ],
    }));

    this.image = new lambda.CfnMicrovmImage(this, 'SegmentImage', {
      name: 'ai-developer-agent-segment',
      description: 'Work segment: git, ripgrep, Node 24, segment server',
      baseImageArn: `arn:aws:lambda:${this.region}:aws:microvm-image:al2023-1`,
      baseImageVersion: cfg.microvmBaseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: { uri: artifact.s3ObjectUrl },
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      resources: [{ minimumMemoryInMiB: cfg.microvmMemoryMiB }],
      // NET_ADMIN is needed to firewall the metadata service from agent commands. Agent commands run as an unprivileged user.
      additionalOsCapabilities: ['ALL'],
      egressNetworkConnectors: [],
      environmentVariables: [
        { key: 'TABLE_NAME', value: state.table.tableName },
        { key: 'TRANSCRIPT_BUCKET', value: state.transcriptBucket.bucketName },
        { key: 'TOKEN_VENDOR_FUNCTION', value: state.tokenVendor.functionArn },
        { key: 'BEDROCK_MODEL_ID', value: cfg.bedrockModelId },
        { key: 'MAX_TOKENS_PER_ISSUE', value: cfg.maxTokensPerIssue },
        { key: 'AGENT_REGION', value: this.region },
        { key: 'ENABLE_FACTORY', value: cfg.enableFactory },
        { key: 'SWAMP_API_KEY_SECRET_ARN', value: state.swampKeySecret.secretArn },
      ],
      hooks: {
        port: 8080,
        microvmImageHooks: { ready: 'ENABLED', validate: 'ENABLED' },
        microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: 30, resume: 'ENABLED', resumeTimeoutInSeconds: 30 },
      },
      logging: { cloudWatch: { logGroup: logGroup.logGroupName } },
    });

    // The orchestrator reads this at runtime. A CloudFormation export cannot change while another stack imports it.
    new ssm.StringParameter(this, 'ImageVersion', { parameterName: IMAGE_VERSION_PARAM, stringValue: this.image.attrLatestActiveImageVersion });

    // Orphan sweeper.
    this.sweeper = new lambda.Function(this, 'Sweeper', {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(bundle('sweeper', 'packages/orchestrator/src/sweeper-handler.ts')),
      timeout: Duration.minutes(2), memorySize: 256,
      environment: { TABLE_NAME: state.table.tableName, MICROVM_IMAGE_ARN: this.image.attrImageArn, SEGMENT_TIMEOUT_SECONDS: '7200' },
    });
    state.table.grantReadData(this.sweeper);
    this.sweeper.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:ListMicrovms', 'lambda:GetMicrovm', 'lambda:TerminateMicrovm'], resources: ['*'] }));
    new events.Rule(this, 'SweepSchedule', { schedule: events.Schedule.rate(Duration.minutes(15)), targets: [new targets.LambdaFunction(this.sweeper)] });

    // Alarm when the sweeper terminates anything: it means the orchestrator lost track of a VM.
    const swept = new logs.MetricFilter(this, 'SweptFilter', {
      logGroup: this.sweeper.logGroup, filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'sweep complete'),
      metricNamespace: 'AiDeveloperAgent', metricName: 'SweeperRuns', metricValue: '1',
    });
    const terminated = new logs.MetricFilter(this, 'TerminatedFilter', {
      logGroup: this.sweeper.logGroup, filterPattern: logs.FilterPattern.literal('{ $.terminated[0] = "*" }'),
      metricNamespace: 'AiDeveloperAgent', metricName: 'SweeperTerminations', metricValue: '1',
    });
    void swept;
    const alarm = new cw.Alarm(this, 'SweeperTerminationsAlarm', {
      metric: terminated.metric({ statistic: 'Sum', period: Duration.minutes(15) }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The sweeper terminated an orphaned or overdue MicroVM',
    });
    if (state.alarmTopic) alarm.addAlarmAction({ bind: () => ({ alarmActionArn: state.alarmTopic!.topicArn }) });
  }
}
