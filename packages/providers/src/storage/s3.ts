import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from '@cms/core';
import type { ObjectStorage, StoredObject } from '../types.js';
import { assertSafeKey } from './keys.js';

type S3Config = Extract<StorageConfig, { driver: 's3' }>;

/** S3-compatible storage (SeaweedFS locally, any S3 API in production). */
export class S3Storage implements ObjectStorage {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
      maxAttempts: 3,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { key, size: body.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (e instanceof NotFound) return false;
      if (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    const key = `_health/${randomUUID()}`;
    await this.put(key, Buffer.from('ok'), 'text/plain');
    await this.delete(key);
  }

  destroy(): void {
    this.client.destroy();
  }
}
