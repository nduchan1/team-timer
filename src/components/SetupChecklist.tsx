import { useState, type ReactNode } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import { notificationPermission, requestNotifications } from '../engine/lifecycle.ts';

type Browser = 'chrome' | 'edge' | 'firefox';

function detectBrowser(): Browser {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  return 'chrome';
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="link"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => {});
      }}
    >
      <code>{text}</code> {done ? '✓ copied' : 'copy'}
    </button>
  );
}

export default function SetupChecklist({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const browser = detectBrowser();
  const host = location.host;
  const [perm, setPerm] = useState(notificationPermission);
  const done = snap.prefs.checklist;
  // Starts open until the first step is ticked; after that the player decides.
  const [open, setOpen] = useState(() => Object.values(done).every((v) => !v));
  const toggle = (id: string, v: boolean) => ctrl.setPrefs({ checklist: { ...done, [id]: v } });

  const steps: { id: string; title: string; body: ReactNode }[] = [
    {
      id: 'keep-active',
      title: browser === 'firefox' ? 'Stop Firefox from unloading the tab' : 'Always keep this site active',
      body:
        browser === 'chrome' ? (
          <>
            Open <Copy text="chrome://settings/performance" /> (paste it in the address bar), find{' '}
            <b>Always keep these sites active</b>, click Add and enter <Copy text={host} />. This stops Chrome from
            unloading or freezing the timer tab.
          </>
        ) : browser === 'edge' ? (
          <>
            <b>Required in Edge</b>: it puts background tabs to sleep after 1–2 hours by default. Open Settings → System
            and performance → Performance, find <b>Never put these sites to sleep</b> (newer versions: “Always keep these
            sites active”), click Add and enter <Copy text={host} />.
          </>
        ) : (
          <>
            Open <Copy text="about:config" />, search <code>browser.tabs.unloadOnLowMemory</code> and set it to{' '}
            <b>false</b>.
          </>
        ),
    },
    {
      id: 'sound-allow',
      title: 'Allow sound for this site',
      body: (
        <>
          Click the icon left of the address bar → Site settings → <b>Sound: Allow</b>. The chime then comes back on its
          own if the tab ever reloads.
        </>
      ),
    },
    {
      id: 'own-window',
      title: 'Give the timer its own small window',
      body: (
        <>
          Drag this tab out into its own window and leave a corner of it visible (or put it on a second screen). A
          visible window is never slowed down or unloaded. The <b>Pop out</b> button does the same with one click, but it
          closes if the tab reloads or another site opens a picture-in-picture video.
        </>
      ),
    },
    {
      id: 'notifications',
      title: 'Allow notifications (backup alert)',
      body: (
        <>
          Only used when the sound is off or raids were missed, never every loop.{' '}
          {perm === 'granted' ? (
            <b>Allowed ✓</b>
          ) : perm === 'unsupported' ? (
            'Not supported in this browser.'
          ) : perm === 'denied' ? (
            'Blocked: allow it in Site settings.'
          ) : (
            <button className="btn small" onClick={() => void requestNotifications().then(setPerm)}>
              Allow notifications
            </button>
          )}
        </>
      ),
    },
    {
      id: 'no-mute',
      title: 'Never mute the tab',
      body: <>A muted tab can’t chime. Use the volume slider here instead.</>,
    },
    {
      id: 'pc-awake',
      title: 'Keep the PC awake',
      body: <>Nothing in a browser can chime while the computer sleeps.</>,
    },
  ];

  const doneCount = steps.filter((s) => done[s.id]).length;

  return (
    <details className="card setup" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <h2>
          Setup for reliable chimes ({doneCount}/{steps.length})
        </h2>
      </summary>
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={done[s.id] ? 'done' : ''}>
            <label className="check">
              <input type="checkbox" checked={!!done[s.id]} onChange={(e) => toggle(s.id, e.target.checked)} />
              <b>{s.title}</b>
            </label>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="muted small">
        Built in: background ticks {snap.usesWorker ? '✓' : '✗'} · freeze lock {snap.lockHeld ? '✓' : '✗'} · pop-out{' '}
        {snap.pipOpen ? 'open ✓' : 'closed'}
      </p>
    </details>
  );
}
