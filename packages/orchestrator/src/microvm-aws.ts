import {
  LambdaMicrovmsClient, RunMicrovmCommand, GetMicrovmCommand, TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand, ListMicrovmsCommand,
} from '@aws-sdk/client-lambda-microvms';
import type { MicrovmApi } from './microvm-launcher.ts';
import type { SweeperApi } from './sweeper.ts';

export function createMicrovmAwsApi(client = new LambdaMicrovmsClient({})): MicrovmApi {
  return {
    async run(a) {
      const r = await client.send(new RunMicrovmCommand({
        imageIdentifier: a.imageArn, imageVersion: a.imageVersion, executionRoleArn: a.executionRoleArn,
        clientToken: a.clientToken, idlePolicy: a.idle, maximumDurationInSeconds: a.maximumDurationInSeconds, runHookPayload: a.runHookPayload,
      }));
      return { microvmId: r.microvmId!, endpoint: r.endpoint!, state: r.state! };
    },
    async get(id) {
      const r = await client.send(new GetMicrovmCommand({ microvmIdentifier: id }));
      return { state: r.state!, endpoint: r.endpoint! };
    },
    async authToken(id, port, minutes) {
      const r = await client.send(new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: id, expirationInMinutes: minutes, allowedPorts: [{ port }],
      }));
      return r.authToken!['X-aws-proxy-auth'];
    },
    async terminate(id) { await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
  };
}

export function createSweeperAwsApi(imageArn: string, client = new LambdaMicrovmsClient({})): SweeperApi {
  return {
    async listActive() {
      const out: Array<{ microvmId: string; startedAt?: Date }> = [];
      let nextToken: string | undefined;
      do {
        const r = await client.send(new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken }));
        for (const i of r.items ?? []) {
          if (i.state !== 'TERMINATING' && i.state !== 'TERMINATED') out.push({ microvmId: i.microvmId!, startedAt: i.startedAt });
        }
        nextToken = r.nextToken;
      } while (nextToken);
      return out;
    },
    async terminate(id) { await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
  };
}
