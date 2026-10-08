import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage, StoredObject } from '../types.js';
import { assertSafeKey } from './keys.js';

/** Stores objects as files under `rootDir`. Paths are built with path.join (Windows-safe). */
export class LocalFsStorage implements ObjectStorage {
  readonly name = 'local';

  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    return path.join(this.rootDir, ...assertSafeKey(key));
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // Write to a temp file then rename, so readers never see a half-written object.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
    return { key, size: body.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async healthCheck(): Promise<void> {
    const key = `_health/${randomUUID()}`;
    await this.put(key, Buffer.from('ok'), 'text/plain');
    await this.delete(key);
  }
}
