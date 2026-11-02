import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sweep } from './sweeper.ts';
import { createSweeperAwsApi } from './microvm-aws.ts';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(): Promise<{ terminated: string[] }> {
  const terminated = await sweep(
    { doc, table: process.env.TABLE_NAME! },
    createSweeperAwsApi(process.env.MICROVM_IMAGE_ARN!),
    { segmentTimeoutSeconds: Number(process.env.SEGMENT_TIMEOUT_SECONDS || 7200) },
  );
  console.log(JSON.stringify({ msg: 'sweep complete', terminated }));
  return { terminated };
}
