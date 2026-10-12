import type { AppConfig, StorageConfig } from '@cms/core';
import { MockImageProvider } from './mock/image.js';
import { MockMailSender } from './mail/mock.js';
import { MockSttProvider } from './stt/mock.js';
import { WhisperCppProvider } from './stt/whispercpp.js';
import { MockInstagramDataProvider } from './mock/instagram.js';
import { MockNotifier } from './mock/notifier.js';
import { StubPublisher } from './publisher.js';
import { LocalFsStorage } from './storage/local.js';
import { S3Storage } from './storage/s3.js';
import type {
  MailSender,
  SttProvider,
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

/** STT engine by STT_PROVIDER. A configuration that cannot work fails here, explicitly. */
export function createSttProvider(config: AppConfig): SttProvider {
  const m = config.media;
  if (m.sttProvider === 'mock') return new MockSttProvider();
  if (m.sttProvider === 'local') {
    if (!m.whisperModel)
      throw new Error(
        'STT_PROVIDER=local: укажите WHISPER_CPP_MODEL (путь к файлу модели ggml-*.bin)',
      );
    return new WhisperCppProvider(m.whisperBin, m.whisperModel);
  }
  throw new Error(
    'STT_PROVIDER=cloud ещё не подключён: нужен выбор сервиса, ключ и «ок» владельца. Используйте mock или local.',
  );
}

/** Mail sender by MAIL_PROVIDER. Real sending stays off until the owner's explicit "ok". */
export function createMailSender(config: AppConfig): MailSender {
  if (config.mail.provider === 'mock') return new MockMailSender();
  throw new Error(
    'MAIL_PROVIDER=smtp ещё не включён: реальная отправка — только после «ок» владельца и тестового письма. Используйте mock.',
  );
}
