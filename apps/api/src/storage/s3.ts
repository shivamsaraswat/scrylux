import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageConfig } from './config.js';
import { StorageUnavailable, assertOriginalKey, parseOriginalKey, type OriginalKey, type Storage, type StoredOriginal } from './types.js';

// Originals in an S3-compatible bucket, as <prefix>sources/<uuid> (STORAGE_S3_*, research #10). Every setting reaches the
// client explicitly, so nothing it would read from the environment on its own can send a document or a credential to
// another address; config.ts refuses to start while such a variable is set. Scrylux deletes only keys of the shape it
// makes, under its own prefix, because the bucket may be shared (research #11).

type S3Config = Extract<StorageConfig, { backend: 's3' }>;

export function createS3Storage(config: S3Config): Storage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    ...(config.accessKeyId === undefined || config.secretAccessKey === undefined
      ? {}
      : { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }),
    // Services other than AWS's refuse the checksums the client adds by default.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    useDualstackEndpoint: false,
    useFipsEndpoint: false,
    // The environment's endpoint settings are refused at start; this makes the client ignore them as well.
    ignoreConfiguredEndpointUrls: true,
  });
  const Bucket = config.bucket;
  const objectKey = (key: OriginalKey): string => `${config.prefix}${key}`;

  return {
    async put(key, bytes) {
      assertOriginalKey(key);
      try {
        await client.send(new PutObjectCommand({ Bucket, Key: objectKey(key), Body: bytes, ContentLength: bytes.length }));
      } catch {
        throw new StorageUnavailable();
      }
    },

    async get(key) {
      assertOriginalKey(key);
      try {
        const answer = await client.send(new GetObjectCommand({ Bucket, Key: objectKey(key) }));
        if (answer.Body === undefined) throw new Error('no body');
        return await answer.Body.transformToByteArray();
      } catch {
        throw new StorageUnavailable();
      }
    },

    async delete(key) {
      assertOriginalKey(key);
      try {
        // Deleting a key that is not there succeeds.
        await client.send(new DeleteObjectCommand({ Bucket, Key: objectKey(key) }));
      } catch {
        throw new StorageUnavailable();
      }
    },

    async *list(): AsyncGenerator<StoredOriginal> {
      const prefix = `${config.prefix}sources/`;
      let token: string | undefined;
      do {
        let page;
        try {
          page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) }));
        } catch {
          throw new StorageUnavailable();
        }
        for (const item of page.Contents ?? []) {
          const key = item.Key === undefined ? undefined : parseOriginalKey(item.Key.slice(config.prefix.length));
          // Only keys of the exact shape, directly under the prefix: another prefix that merely starts the same, or
          // something nested, is not Scrylux's.
          if (key === undefined || item.Key !== objectKey(key)) continue;
          yield { key, modifiedAt: item.LastModified ?? new Date() };
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
    },
  };
}
