/**
 * Provider contracts. Concrete implementations are chosen by config (PROVIDERS_MODE).
 * Stage 0 ships mock implementations only; real ones are added in later stages:
 *   - ImageProvider: Magnific adapter (stage 3)
 *   - InstagramDataProvider: CsvImportProvider (stage 3/4), Graph API (stage 4)
 *   - Notifier: Telegram (stage 2)
 *   - Publisher: interface + stub only; auto-publishing is out of scope.
 * Signatures may be extended when the real adapters are built against actual API docs.
 */

export interface ImageGenerationRequest {
  prompt: string;
  width: number;
  height: number;
  /** Omitted -> provider picks one; the chosen seed is always returned for reproducibility. */
  seed?: number;
  model?: string;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  seed: number;
  model: string;
  provider: string;
  /** Every parameter sent to the provider, stored for reproducibility. */
  params: Record<string, unknown>;
}

export interface ImageProvider {
  readonly name: string;
  generate(req: ImageGenerationRequest): Promise<GeneratedImage>;
}

export type InstagramMediaType = 'IMAGE' | 'VIDEO' | 'REELS' | 'CAROUSEL_ALBUM';

export interface InstagramPostMetrics {
  postId: string;
  permalink: string | null;
  mediaType: InstagramMediaType;
  caption: string | null;
  postedAt: string;
  /** Metric name -> value, e.g. reach, likes, saves. */
  metrics: Record<string, number>;
  /** Where the numbers came from (e.g. "mock", "csv:export-2026-10.csv"). Shown in analyst reports. */
  source: string;
}

export interface InstagramDataProvider {
  readonly name: string;
  listPosts(range: { since?: Date; until?: Date }): Promise<InstagramPostMetrics[]>;
}

export interface NotifierButton {
  text: string;
  /** Opaque payload returned on press; carries the idempotency key in later stages. */
  data: string;
}

export interface NotifierMessage {
  text: string;
  buttons?: NotifierButton[][];
}

export interface Notifier {
  readonly name: string;
  send(msg: NotifierMessage): Promise<{ messageId: string }>;
}

export interface PublishRequest {
  brandId: string;
  taskId: string;
  artifactIds: string[];
}

export type PublishResult =
  { status: 'skipped'; reason: string } | { status: 'published'; externalId: string };

export interface Publisher {
  readonly name: string;
  publish(req: PublishRequest): Promise<PublishResult>;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface ObjectStorage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Throws if the storage is not reachable/writable. Used by /health. */
  healthCheck(): Promise<void>;
}
