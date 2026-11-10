import type { Message } from '@aws-sdk/client-bedrock-runtime';

/** Transcripts can hold image bytes (from view_image). JSON cannot, so bytes round-trip as base64 markers. */
export const serializeTranscript = (messages: Message[]): string =>
  JSON.stringify(messages, (_k, v) => (v instanceof Uint8Array ? { __b64: Buffer.from(v).toString('base64') } : v));

export const parseTranscript = (json: string): Message[] =>
  JSON.parse(json, (_k, v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? new Uint8Array(Buffer.from(v.__b64, 'base64')) : v));
