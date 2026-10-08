/** Test helpers for the agents package (not part of the build). */
import type { NotifierMessage } from '@cms/providers';
import type { ExportView, OwnerChannel, PackageView, PlanView } from './channel.js';

export class RecordingChannel implements OwnerChannel {
  readonly name = 'recording';
  readonly plans: PlanView[] = [];
  readonly packages: PackageView[] = [];
  readonly exports: ExportView[] = [];
  readonly messages: NotifierMessage[] = [];

  send(msg: NotifierMessage) {
    this.messages.push(msg);
    return Promise.resolve({ messageId: String(this.messages.length) });
  }
  sendPlan(v: PlanView) {
    this.plans.push(v);
    return Promise.resolve();
  }
  sendPackage(v: PackageView) {
    this.packages.push(v);
    return Promise.resolve();
  }
  sendExport(v: ExportView) {
    this.exports.push(v);
    return Promise.resolve();
  }
}
