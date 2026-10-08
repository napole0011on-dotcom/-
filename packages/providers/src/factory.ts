import type { AppConfig, StorageConfig } from '@cms/core';
import { MockImageProvider } from './mock/image.js';
import { MockInstagramDataProvider } from './mock/instagram.js';
import { MockNotifier } from './mock/notifier.js';
import { StubPublisher } from './publisher.js';
import { LocalFsStorage } from './storage/local.js';
import { S3Storage } from './storage/s3.js';
import type {
  ImageProvider,
  InstagramDataProvider,
  Notifier,
  ObjectStorage,
  Publisher,
} from './types.js';

export interface Providers {
  image: ImageProvider;
  instagram: InstagramDataProvider;
  notifier: Notifier;
  publisher: Publisher;
}

export function createStorage(cfg: StorageConfig): ObjectStorage {
  return cfg.driver === 's3' ? new S3Storage(cfg) : new LocalFsStorage(cfg.dir);
}

export function createProviders(config: AppConfig): Providers {
  if (config.providersMode === 'real') {
    // Not a silent fallback: real adapters do not exist yet.
    throw new Error(
      'PROVIDERS_MODE=real is not implemented yet (Telegram: stage 2, Magnific: stage 3, Instagram: stage 4). Use PROVIDERS_MODE=mock.',
    );
  }
  return {
    image: new MockImageProvider(),
    instagram: new MockInstagramDataProvider(),
    notifier: new MockNotifier(),
    publisher: new StubPublisher({ publishEnabled: config.publishEnabled, dryRun: config.dryRun }),
  };
}
