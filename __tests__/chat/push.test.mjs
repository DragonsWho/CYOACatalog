import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('public/sw.js', 'utf8');
function fixture(channel, at) {
  const handlers = {}; const shown = []; const delivered = []; const closed = [];
  const client = { visibilityState: 'visible', url: 'https://cyoa.test/', postMessage(data, ports) {
    if (ports) ports[0].reply({ chatOpen: true, channel, at }); else delivered.push(data);
  } };
  const cards = [{ data: { channel: 'dm', created: '2026-09-19T10:00:00.100Z' }, close() { closed.push('dm'); } },
    { data: { channel: 'other', created: '2026-09-19T10:00:00.100Z' }, close() { closed.push('other'); } }];
  const self = { addEventListener(name, fn) { handlers[name] = fn; }, clients: { matchAll: async () => [client] },
    registration: { showNotification: async (title, options) => shown.push({title, ...options}), getNotifications: async () => cards } };
  class MessageChannel { constructor() { this.port1 = {}; this.port2 = { reply: data => this.port1.onmessage({data}) }; } }
  vm.runInNewContext(source, { self, MessageChannel, setTimeout, Promise, Date, URL });
  return { shown, delivered, closed, async dispatch(name, data) { let work; handlers[name]({ data: name === 'push' ? { json: () => data } : data, waitUntil(p) {work=p;} }); await work; } };
}
const payload = { title: 'New DM', channel: 'dm', created: '2026-09-19T10:00:00.100Z', recipient: 'alice', dm: true, url: '/chat?channel=dm&message=m1', tag: 'shout-room-dm' };
{
  const f=fixture('dm', Date.parse(payload.created));await f.dispatch('push',payload);
  assert.equal(f.shown.length,0,'already read conversation stays silent');
  assert.equal(f.delivered[0].type,'cyoa-chat-push','visible page receives the signal without polling');
}
{
  const f=fixture('other',Date.now());await f.dispatch('push',payload);
  assert.equal(f.shown.length,1,'another open room must not suppress a DM');
  assert.equal(f.shown[0].data.url,payload.url,'push opens the exact conversation');
  await f.dispatch('message',{type:'cyoa-chat-read',channel:'dm',at:Date.parse(payload.created)});
  assert.deepEqual(f.closed,['dm'],'reading one conversation keeps other notifications');
}
{
  const f=fixture('dm',0);await f.dispatch('push',payload);
  assert.equal(f.shown.length,1,'reading old history must not suppress a new DM');
}
console.log('Push service worker regressions passed');
