import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('src/components/Notifications/chatAttention.ts', 'utf8');
function fixture() {
  const timers = new Map(); let nextTimer = 0;
  const events = new Map(); const storage = new Map(); const sent = [];
  const bus = { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  const pb = { authStore: { record: { id: 'alice' } }, send: async (...args) => { sent.push(args); return { ok: true }; } };
  const context = {
    exports: {}, require: (name) => name.includes('pocketbase') ? { pb, notificationsCollection: {} } : { createLease: () => ({ hold: () => false, release() {} }) },
    window: bus, document: { ...bus, visibilityState: 'visible' }, navigator: {},
    localStorage: { setItem(k, v) { storage.set(k, v); }, getItem(k) { return storage.get(k) ?? null; } },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { return 0; }, clearInterval() {}, Date, console,
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const api = context.exports;
  api.startAttention('alice');
  return { api, events, storage, pb, sent, async flush() { const batch = [...timers.values()]; timers.clear(); for (const fn of batch) fn(); await new Promise(setImmediate); } };
}
const first = '2026-09-19 10:00:00.100Z';
const second = '2026-09-19 10:00:00.200Z';
const at = (s) => Date.parse(s);
const summary = (created = first) => ({ count: 1, channels: { dm: { latest: at(created), dm: true } }, reads: {}, notifications: { dm: 1 } });

{
  const { api } = fixture();
  api.applyAttention(summary());
  const version = api.attentionRevision();
  api.readAttention('dm', 'm1', first);
  api.applyAttention(summary(), version);
  assert.equal(api.unreadAttention('dm'), false, 'late poll must not resurrect a read DM');
  assert.equal(api.getAttention().count, 0);
  api.noteAttention('dm', second, true);
  assert.equal(api.unreadAttention('dm'), true, 'another message in the same second is new');
  api.applyAttention(summary(), version);
  assert.equal(api.getAttention().channels.dm.latest, at(second), 'poll must not erase realtime');
}
{
  const { api } = fixture();
  api.applyAttention(summary());
  api.readNotificationTray([{ read: false, shout_channel: 'dm' }]);
  assert.equal(api.getAttention().count, 0);
  assert.equal(api.unreadAttention('dm'), true, 'opening the bell does not read the conversation');
}
{
  const f = fixture();
  f.pb.send = async (...args) => { f.sent.push(args); throw Error('offline'); };
  f.api.readAttention('dm', 'm1', first);
  await f.flush();
  assert.equal(f.sent.length, 1);
  f.pb.send = async (...args) => { f.sent.push(args); return { ok: true }; };
  await f.flush();
  assert.equal(f.sent.length, 2, 'read acknowledgement is retried');
  await f.flush();
  assert.equal(f.sent.length, 2, 'successful acknowledgement stops retries');
}
{
  const f = fixture();
  f.api.applyAttention(summary());
  const remote = { state: { ...summary(), count: 0, reads: { dm: at(first) }, notifications: {} }, pending: {}, at: Date.now() };
  f.events.get('storage')({ key: 'chat-attention:alice', newValue: JSON.stringify(remote) });
  assert.equal(f.api.unreadAttention('dm'), false, 'other-tab read clears the local indicator');
  f.api.startAttention('bob');
  assert.equal(Object.keys(f.api.getAttention().channels).length, 0, 'accounts never share unread state');
}
{
  const { api } = fixture();
  api.applyAttention({ ...summary(), count: 2 });
  api.readAttention('dm', 'm1', first);
  api.readNotificationTray([{ read: false, shout_channel: 'dm' }]);
  assert.equal(api.getAttention().count, 1, 'overlapping chat and tray reads must not subtract an unrelated event');
}
console.log('Chat attention regressions passed');
