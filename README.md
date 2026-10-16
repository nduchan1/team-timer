# ⏳ Team Timer

**A shared looping raid timer for Travian teams.** One secret link shows the whole team the same countdown and
loop count. A chime plays at every raid moment, and it keeps playing while you are tabbed into the game.

**Live:** https://team-timer-ten.vercel.app

Built for Hun rainbow raiding, where someone has to click "start farm lists" every few minutes (for example every 3:30),
and duals need to hand that job over without doing "next raid at…" math on Discord.

## What it does

- **Looping countdown** with a synthesized chime at 0. It restarts on its own, forever, until stopped.
- **Team sync.** Anyone with the link sees the live countdown, the loop count and who changed it last. Anyone can use:
  - Start, Stop and Resume;
  - **Raided now**, which re-syncs to your click;
  - ±1/±5 s nudges;
  - a new interval, which takes effect after the next raid.
- **Server clock.** Every player's countdown is computed from the server's time, so a PC clock that is off does not matter.
- **Who's on duty.** Shows who has the timer open and who is doing the raid clicks.
  - One row per person: a phone and a PC under the same name count as one.
  - On-duty survives a quick reload.
  - While you're on duty, the timer keeps the screen awake. This is per device, and only while its page or pop-out is visible.
  - An optional per-player setting, "chime only while I'm on duty (or nobody is)", keeps the chime from ringing for
    everyone. It never mutes you because your own other device is on duty.
- **Team chat** in every room:
  - The latest 50 messages, grouped by sender.
  - An unread count in the tab title (and in the pop-out) while you're tabbed into the game.
  - One-click hand-off buttons, each of which posts a message:
    - "Taking over" (sets you on duty);
    - "Ask for cover" (keeps you on duty, with your chime; once someone else goes on duty, a banner offers "I'm off now");
    - "I'm off now" (takes this device off duty);
    - "Back".
- **Warning chime** a few seconds before each raid (optional, per player).
- **Pop-out**: a small always-on-top picture-in-picture timer (Chrome/Edge). Its one status line shows the most important
  thing: sound off, offline, missed chimes, silenced, update ready, new chat, or who's on duty.
- **Updates**: a timer left open for days notices a new deploy and offers a reload.

### Why the chime survives a background tab

| Problem | What the app does |
|---|---|
| Chrome slows timers in hidden tabs, down to one wake-up per minute | The chime is scheduled ahead on the Web Audio clock, which runs on the audio thread. Ticks come from a Web Worker, which is not throttled. |
| Drift and lost ticks | Nothing is counted up. Every value is recomputed from the shared start moment, the interval and the server clock. |
| Chrome freezing the tab (Energy Saver, low memory) | The page holds a Web Lock, which exempts it from freezing. |
| Memory Saver unloading the tab | The tab title updates every second. The app also detects a discard, shows a banner and sends a notification. The in-app setup checklist shows how to add the site to "Always keep these sites active". |
| Missed raids after sleep or a freeze | The app plays no burst of chimes. It counts the missed raids and shows them. |

## Setup (one time)

1. **Firebase** (free Spark plan, no card):
   1. Open [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**. Analytics can stay off.
   2. Go to **Build → Realtime Database → Create database**. Choose the location **europe-west1 (Belgium)**; you cannot change it later. Start in **locked mode**.
   3. In the **Rules** tab, paste the contents of [`database.rules.json`](database.rules.json) and click **Publish**.
   4. Open **Project settings** (gear icon) → **Your apps** → **Web** (`</>`). Register the app (Hosting not needed) and copy the config values.
2. Copy `.env.example` to `.env.local` and fill in the four `VITE_FIREBASE_*` values.
   The database URL looks like `https://<project>-default-rtdb.europe-west1.firebasedatabase.app`.

Without a Firebase config the app runs in **local mode**, which syncs only between tabs of one browser. Local mode is
handy for development.

## Develop

```bash
npm install
npm run dev      # dev server
npm test         # unit tests (timer math, clock sync, chime planning, synth, ids)
npm run build    # type-check + production build
npm run lint
```

## Deploy (Vercel)

```bash
vercel link                                        # once (project: team-timer)
vercel env add VITE_FIREBASE_API_KEY production    # repeat for the 4 variables
vercel --prod
```

**Rules first:** whenever `database.rules.json` changes, publish it before (or together with) the app: paste it into the
Firebase console → Realtime Database → Rules, or run `npx firebase-tools deploy --only database`. `firebase.json` is set up for that.
An app deployed on top of old rules gets its new writes refused.

Routing uses the URL hash (`/#<room id>`), so no rewrites are needed. The room ID never reaches the server.

## Architecture

```
src/lib/timerMath.ts      pure timer math: shared {anchor, interval, loopBase, running} → countdown, loops
src/lib/clockSync.ts      server-clock offset (Cristian's algorithm over RTDB write-acks), jump detection
src/sync/                 SyncAdapter interface; Firebase RTDB and local-mode implementations
src/engine/controller.ts  one controller per room, outside React: ticks, chime schedule, banners, snapshot
src/engine/ticker.ts      Web Worker tick source
src/engine/lifecycle.ts   Web Lock, freeze/resume, discard detection, notification fallback
src/engine/pip.ts         Document Picture-in-Picture pop-out
src/audio/                AudioContext engine + synthesized chimes
database.rules.json       RTDB security rules: the room link is the key; the timer can't be deleted; every field is validated;
                          chat is append-only (300 chars, max 5 messages/s per room)
```

**Limits:** the free Spark plan allows 100 simultaneous connections, meaning 100 open tabs across all teams. All sync code sits behind
`SyncAdapter`, so a move to another backend (for example Cloudflare Durable Objects) replaces one module.

## Disclaimer

Fan-made tool for Travian: Legends players. Not affiliated with Travian Games GmbH.
