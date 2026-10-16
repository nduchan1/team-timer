import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { Handoff, Snapshot, TimerController } from '../engine/controller.ts';
import { useChat } from '../hooks/useRoom.ts';
import { CHAT_MAX_LEN } from '../lib/chat.ts';

const HANDOFFS: { kind: Handoff; label: string; title: string }[] = [
  { kind: 'take', label: '🛡️ Taking over', title: 'Tell the team you take the raids, and mark yourself on duty' },
  {
    kind: 'cover',
    label: '🆘 Ask for cover',
    title: 'Ask who can take over. You stay on duty, with your chime, until you tap “I’m off now”',
  },
  { kind: 'off', label: '💤 I’m off now', title: 'Tell the team you stopped raiding, and take yourself off duty' },
  { kind: 'back', label: '👋 Back', title: 'Tell the team you are back' },
];

/** Near enough to the bottom that new messages should scroll into view. */
const STICKY_PX = 48;

export default function Chat({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const chat = useChat(ctrl);
  const [text, setText] = useState('');
  const [newBelow, setNewBelow] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);
  const disabled = !snap.canChat;

  // Keep the newest message in view, unless the player scrolled up to read older ones.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setNewBelow(true);
  }, [chat]);

  // A resized log (window resize, team list growing) stays pinned to the newest message.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX;
    if (stuck.current) setNewBelow(false);
  };

  const jump = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setNewBelow(false);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const draft = text;
    if (!draft.trim()) return;
    setText('');
    stuck.current = true;
    const ok = await ctrl.sendChat(draft);
    if (!ok) setText((cur) => cur || draft); // give the text back unless something new was typed
  };

  return (
    <section className="card chat" aria-label="Team chat">
      <h2>Chat</h2>
      <div className="chat-body">
        {/* One item per message, keyed by id: old messages are never re-announced, and relabelled
            times are ignored by screen readers (additions only). */}
        <ol className="chat-log" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
          {chat.error && <li className="chat-empty error">Chat unavailable: {chat.error}</li>}
          {chat.loaded && !chat.error && chat.items.length === 0 && (
            <li className="chat-empty muted">No messages yet. Use the buttons below to hand over the raids.</li>
          )}
          {chat.items.map((m) => (
            <li key={m.id} className={`chat-item ${m.mine ? 'mine' : ''} ${m.showHeader ? 'head' : ''}`}>
              {m.showHeader ? (
                <div className="chat-meta">
                  <b>{m.mine ? 'You' : m.name}</b> <span className="muted">{m.time}</span>
                </div>
              ) : (
                <span className="sr-only">{m.mine ? 'You' : m.name}: </span>
              )}
              <p className="chat-bubble">{m.text}</p>
            </li>
          ))}
        </ol>
        {newBelow && (
          <button className="btn small chat-jump" onClick={jump}>
            New messages ↓
          </button>
        )}
      </div>
      <div className="chat-quick" role="group" aria-label="Quick hand-off messages">
        {HANDOFFS.map((h) => (
          <button
            key={h.kind}
            className="btn small"
            disabled={disabled || snap.handoffBusy}
            title={h.title}
            onClick={() => void ctrl.handoff(h.kind)}
          >
            {h.label}
          </button>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input
          className="grow"
          value={text}
          maxLength={CHAT_MAX_LEN}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? (snap.joined ? 'Offline' : 'Join to chat') : 'Message your team'}
          aria-label="Chat message"
          disabled={disabled}
        />
        <button className="btn primary" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
      {text.length > CHAT_MAX_LEN - 50 && (
        <p className="muted small chat-count">
          {text.length}/{CHAT_MAX_LEN}
        </p>
      )}
    </section>
  );
}
