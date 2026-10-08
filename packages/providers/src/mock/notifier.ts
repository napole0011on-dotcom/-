import type { Notifier, NotifierMessage } from '../types.js';

/** Records messages in memory instead of sending them. */
export class MockNotifier implements Notifier {
  readonly name = 'mock';
  readonly sent: NotifierMessage[] = [];

  send(msg: NotifierMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    return Promise.resolve({ messageId: `mock-${this.sent.length}` });
  }
}
