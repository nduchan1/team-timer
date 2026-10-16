// The pop-out has room for one status line under its buttons, so the most important message wins.

import type { SoundState } from '../audio/audioEngine.ts';
import type { ClockQuality } from '../lib/clockSync.ts';

export interface PopLineInput {
  joined: boolean;
  sound: SoundState;
  mode: 'firebase' | 'local';
  connected: boolean;
  clockQuality: ClockQuality;
  /** Missed chimes while the "missed" banner is up (0 once dismissed). */
  missedShown: number;
  /** Other people on duty, when "chime only while I'm on duty" is what keeps this tab silent. */
  silencedBy: string[];
  updateReady: boolean;
  chatUnread: number;
  /** Label of a due reminder not yet dismissed in this tab. */
  reminderDue: string | null;
  onDutyNames: string[];
}

export interface PopLine {
  tone: 'red' | 'amber' | 'info' | 'gold' | 'muted';
  text: string;
  /** A one-tap fix shown after the text. */
  action?: 'on-duty';
}

export function popLine(s: PopLineInput): PopLine {
  if (s.joined && s.sound !== 'running') return { tone: 'red', text: '🔇 Sound is off: open the timer tab' };
  if (s.mode === 'firebase' && !s.connected) return { tone: 'amber', text: 'Offline: controls paused' };
  if (s.mode === 'firebase' && s.clockQuality === 'none') return { tone: 'muted', text: 'Syncing clock…' };
  if (s.missedShown > 0) {
    return { tone: 'red', text: `⚠ ${s.missedShown} chime${s.missedShown === 1 ? '' : 's'} missed: check the loop` };
  }
  // Chat (a cover request) clears as soon as the timer tab is looked at; the next lines can last for
  // hours and show elsewhere too (🔕 in the tab title, the update banner), so chat goes first.
  if (s.chatUnread > 0) return { tone: 'gold', text: `💬 ${s.chatUnread} new message${s.chatUnread === 1 ? '' : 's'}` };
  // Silence comes before a due reminder: it has a one-tap fix, and a reminder can stay due for hours.
  if (s.silencedBy.length > 0) return { tone: 'amber', text: `🔕 Silent: ${s.silencedBy.join(', ')} on duty`, action: 'on-duty' };
  if (s.reminderDue) return { tone: 'gold', text: `⏰ ${s.reminderDue} is ready` };
  if (s.updateReady) return { tone: 'info', text: 'Update ready: reload the timer tab' };
  if (s.onDutyNames.length > 0) return { tone: 'muted', text: `On duty: ${s.onDutyNames.join(', ')}` };
  return { tone: 'muted', text: 'Nobody is on raid duty' };
}
