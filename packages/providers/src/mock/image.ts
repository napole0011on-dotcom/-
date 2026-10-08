import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { GeneratedImage, ImageGenerationRequest, ImageProvider } from '../types.js';

/**
 * Deterministic fake image generator for tests and mock mode: a solid-colour PNG whose
 * colour is derived from prompt + seed. Same input -> same bytes, so idempotency tests work.
 */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';
  readonly calls: ImageGenerationRequest[] = [];

  async generate(req: ImageGenerationRequest): Promise<GeneratedImage> {
    this.calls.push(req);
    const seed = req.seed ?? createHash('sha256').update(req.prompt).digest().readUInt32BE(0);
    const h = createHash('sha256').update(`${req.prompt}|${seed}`).digest();
    const data = await sharp({
      create: {
        width: req.width,
        height: req.height,
        channels: 3,
        background: { r: h[0]!, g: h[1]!, b: h[2]! },
      },
    })
      .png()
      .toBuffer();
    const model = req.model ?? 'mock-v1';
    return {
      data,
      mimeType: 'image/png',
      width: req.width,
      height: req.height,
      seed,
      model,
      provider: this.name,
      params: { prompt: req.prompt, width: req.width, height: req.height, seed, model },
    };
  }
}
