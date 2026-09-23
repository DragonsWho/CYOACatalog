// "Chat is open on this page" — answer for the service worker. One call-out would otherwise produce
// TWO signals: chat sound and a system notification. Author's rule: chat visible → sound only; chat
// closed/minimized/other tab → notification. Asked of the page, not computed on the server: the
// server only knows "device pinged from chat recently" (±minutes) and muting on that loses
// call-outs; the browser knows exactly and for free. Mechanics: the SW asks VISIBLE tabs via a
// message with a reply port on each push; no answer within 250ms → assume no chat, show
// notification. Silence both ways is not allowed: a push without a shown notification is a browser
// violation, so "unknown" = show.

let chatOpen = false;
let reading = { channel: '', at: 0 };
export function setChatReading(channel: string, at: number) { reading = { channel, at }; }
let listening = false;

// SW asks; installed once per session.
function listen() {
  if (listening || !('serviceWorker' in navigator)) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    if (!e.data || e.data.type !== 'cyoa-chat-probe') return;
    const port = e.ports && e.ports[0];
    if (port) port.postMessage({ chatOpen, ...reading });
  });
}

// Chat mounted (/chat page or header drawer) — or closed.
export function setChatOpen(open: boolean) {
  chatOpen = open;
  if (!open) setChatReading('', 0);
  if (open) listen();
}
