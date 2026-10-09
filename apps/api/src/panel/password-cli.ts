/**
 * pnpm panel:password — asks for a password (input hidden) and prints the line to put
 * into .env. The password itself is never stored anywhere.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '@cms/core';

const MIN_LENGTH = 8;

async function main() {
  let muted = false;
  // Echo prompts, hide what the user types.
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  // One interface for both questions: with piped input a second interface would lose buffered lines.
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string) => {
    muted = false;
    output.write(question);
    muted = true;
    const line: IteratorResult<string> = await lines.next();
    process.stdout.write('\n');
    return line.done ? '' : line.value;
  };
  try {
    const first = await ask('Пароль для панели (не отображается): ');
    if (first.length < MIN_LENGTH) throw new Error(`Пароль короче ${MIN_LENGTH} символов`);
    const second = await ask('Повторите пароль: ');
    if (first !== second) throw new Error('Пароли не совпадают');
    const hash = await hashPassword(first);
    console.log('\nДобавьте эту строку в .env (замените, если такая уже есть):\n');
    console.log(`PANEL_PASSWORD_HASH=${hash}`);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
