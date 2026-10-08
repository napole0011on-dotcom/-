import { defineConfig } from 'drizzle-kit';

// Only used for `drizzle-kit generate` (SQL diff from the TS schema). Applying and
// rolling back migrations is done by our own runner (src/migrator.ts), because
// drizzle-kit has no down migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
