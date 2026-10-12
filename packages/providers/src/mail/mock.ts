import { createHash } from 'node:crypto';
import type { MailMessage, MailSender } from '../types.js';

/** Nothing leaves the computer: messages are kept in memory (tests) and counted. */
export class MockMailSender implements MailSender {
  readonly name = 'mock';
  readonly sent: MailMessage[] = [];

  send(msg: MailMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    const id = createHash('sha256').update(`${msg.to}|${msg.subject}|${this.sent.length}`);
    return Promise.resolve({ messageId: `mock-${id.digest('hex').slice(0, 16)}` });
  }
}
