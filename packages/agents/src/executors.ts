import type { AppConfig } from '@cms/core';
import type { Db } from '@cms/db';
import type { ImageProvider, ObjectStorage } from '@cms/providers';
import { imageExecutor } from './agents/image.js';
import { kpExecutor } from './agents/kp.js';
import { kpRenderExecutor } from './tools/kp-render.js';
import type { NodeExecutor } from './nodes.js';

/** Board steps implemented in code (constructor agents are resolved from the registry). */
export function codeExecutors(d: {
  db: Db;
  config: AppConfig;
  image: ImageProvider;
  storage: ObjectStorage;
}): Record<string, NodeExecutor> {
  return {
    image: imageExecutor({
      db: d.db,
      provider: d.image,
      storage: d.storage,
      budget: { config: d.config.budget, timeZone: d.config.timezone },
      estimateUsd: d.image.name === 'mock' ? 0 : d.config.imageMaxCostUsd,
    }),
    kp: kpExecutor({ catalogFile: d.config.kp.catalogFile, vatPercent: d.config.kp.vatPercent }),
    kp_render: kpRenderExecutor({ storage: d.storage }),
  };
}
