import type { Publisher, PublishRequest, PublishResult } from './types.js';

/**
 * Publishing stub. Auto-publishing is out of scope (export only), so this never calls
 * any platform. It exists so the pipeline has a single, explicit place where publishing
 * would happen, guarded by PUBLISH_ENABLED and DRY_RUN.
 */
export class StubPublisher implements Publisher {
  readonly name = 'stub';
  readonly requests: PublishRequest[] = [];

  constructor(private readonly flags: { publishEnabled: boolean; dryRun: boolean }) {}

  publish(req: PublishRequest): Promise<PublishResult> {
    this.requests.push(req);
    const reason = !this.flags.publishEnabled
      ? 'PUBLISH_ENABLED=false'
      : this.flags.dryRun
        ? 'DRY_RUN=true'
        : 'publishing is not implemented (export-only setup)';
    return Promise.resolve({ status: 'skipped', reason });
  }
}
