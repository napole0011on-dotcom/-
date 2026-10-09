/**
 * pnpm panel:password — asks for a password (input hidden) and prints the line to put
 * into .env. The password itself is never stored anywhere.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '@cms/core';

function ask(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const first = await ask('Пароль для панели (не отображается): ');
  const second = await ask('Повторите пароль: ');
  if (first !== second) throw new Error('Пароли не совпадают');
  const hash = await hashPassword(first);
  console.log('\nДобавьте эту строку в .env (замените, если такая уже есть):\n');
  console.log(`PANEL_PASSWORD_HASH=${hash}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
