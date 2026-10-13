import type { AppConfig } from '@cms/core';
import type { Db } from '@cms/db';
import type { ImageProvider, ObjectStorage } from '@cms/providers';
import type { AgentSelf } from './agents/context.js';
import { imageExecutor } from './agents/image.js';
import { kpExecutor } from './agents/kp.js';
import { kpRenderExecutor } from './tools/kp-render.js';
import type { NodeExecutor } from './nodes.js';

/** Builds the step executor of an agent that has this capability. */
export type CapabilityExecutor = (self: AgentSelf) => NodeExecutor;

/**
 * Board steps implemented in code, by capability (agents without one run as LLM agents by
 * their fields; «copywriting» is run by the workflow itself, it writes the copy:* slots).
 */
export function capabilityExecutors(d: {
  db: Db;
  config: AppConfig;
  image: ImageProvider;
  storage: ObjectStorage;
}): Record<string, CapabilityExecutor> {
  return {
    image_generate: (self) =>
      imageExecutor({
        db: d.db,
        provider: d.image,
        storage: d.storage,
        budget: { config: d.config.budget, timeZone: d.config.timezone },
        estimateUsd: d.image.name === 'mock' ? 0 : d.config.imageMaxCostUsd,
        self,
      }),
    kp_draft: (self) =>
      kpExecutor({
        catalogFile: d.config.kp.catalogFile,
        vatPercent: d.config.kp.vatPercent,
        self,
      }),
    kp_render: () => kpRenderExecutor({ storage: d.storage }),
  };
}
