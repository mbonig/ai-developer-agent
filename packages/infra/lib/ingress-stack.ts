import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { bundle } from './bundle.ts';
import { settings } from './props.ts';
import type { OrchestratorStack } from './orchestrator-stack.ts';
import type { StateStack } from './state-stack.ts';

export interface IngressProps extends StackProps { state: StateStack; orchestrator: OrchestratorStack }

/** The public webhook endpoint. Authentication is the GitHub signature, verified in the function. */
export class IngressStack extends Stack {
  readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: IngressProps) {
    super(scope, id, props);
    const cfg = settings(this);
    const { state, orchestrator } = props;

    this.fn = new lambda.Function(this, 'Ingress', {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(bundle('ingress', 'packages/ingress/src/index.ts')),
      timeout: Duration.seconds(10), memorySize: 256,
      environment: {
        TABLE_NAME: state.table.tableName,
        WEBHOOK_SECRET_ARN: state.webhookSecret.secretArn,
        ORCHESTRATOR_FUNCTION_ARN: orchestrator.alias.functionArn, // qualified ARN, required for durable invocations
        GITHUB_ORG: cfg.githubOrg,
        AGENT_LABEL: cfg.agentLabel,
      },
    });
    state.table.grantReadWriteData(this.fn);
    state.webhookSecret.grantRead(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction', 'lambda:SendDurableExecutionCallbackSuccess'],
      resources: [orchestrator.fn.functionArn, `${orchestrator.fn.functionArn}:*`],
    }));

    const url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new CfnOutput(this, 'WebhookUrl', { value: url.url, description: 'Set this as the GitHub App webhook URL' });

    const errors = new cw.Alarm(this, 'Ingress5xxAlarm', {
      metric: this.fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }), threshold: 1, evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'Webhook ingress is failing',
    });
    if (state.alarmTopic) errors.addAlarmAction({ bind: () => ({ alarmActionArn: state.alarmTopic!.topicArn }) });
  }
}
