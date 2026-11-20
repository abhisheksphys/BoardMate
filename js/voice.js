// Voice in (browser speech recognition) and voice out (speech synthesis), with barge-in.
import { settings } from './settings.js';
import { emit } from './bus.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// On iPad and iPhone, Safari only gives a listening run real microphone audio when a tap started it.
// Runs the app starts by itself report "started" but hear nothing (voice log, Nov 2026: none of 29 such
// runs heard a word). So there the app never restarts listening on its own; it says so and you tap the mic.
const TAP_ONLY = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;

class Voice {
  constructor() {
    this.supported = !!SR;
    this.listening = false;
    this.want = false; // the mic is switched on
    this.heard = ''; // text from earlier recognition runs that hasn't been sent yet
    this.runText = ''; // what the current run has recognised and not yet sent
    this.runSent = ''; // what the current run recognised that was already sent
    this.lastSent = '';
    this.lastSentAt = 0;
    this.retries = 0;
    this.lastActivity = 0;
    this.lastStartAttempt = 0;
    // Safari's recogniser on iPad sometimes dies silently (stops hearing, never says it ended), and iOS
    // sometimes never reports that spoken output finished. A small watchdog notices both and recovers.
    setInterval(() => this.watch(), 1500);
  }

  watch() {
    if (!this.want || !this.supported) return;
    const now = Date.now();
    if (this.mutedSpeech) this.isMuted(); // notices speech output that ended without telling us
    if (!this.listening && now - this.lastStartAttempt > 2500) {
      if (TAP_ONLY) this.stoppedOnItsOwn('not listening');
      else { this.debug('mic was meant to be on but was not listening: restarting'); this.startRec('watchdog: not listening'); }
    }
  }

  // Voice log: every recogniser event and every app action, with times, so problems on a real iPad can be
  // diagnosed from evidence. Settings → Voice → Copy voice log.
  log(ev, detail = '') {
    this.events ||= [];
    this.t0 ||= Date.now();
    const t = ((Date.now() - this.t0) / 1000).toFixed(2).padStart(8) + 's';
    const body = `${ev}${detail ? '  ' + detail : ''}`;
    // Speech recognition repeats the same result many times a second; keep one line and count repeats,
    // so minutes of listening fit in the log.
    const last = (this.recentLog || []).find((r) => r.body === body);
    if (last) {
      last.n++;
      this.events[last.i] = `${last.t}  ${body}   (×${last.n}, last at ${t.trim()})`;
      return;
    }
    if (this.events.length >= 1500) { this.events.splice(0, 300); this.recentLog = []; }
    this.events.push(`${t}  ${body}`);
    this.recentLog = [{ body, t, n: 1, i: this.events.length - 1 }, ...(this.recentLog || [])].slice(0, 2);
  }

  report() {
    const keys = ['voiceSend', 'voiceSendDelaySec', 'headphones', 'voiceOut', 'narration', 'liveSpeak', 'wakeWord'];
    const conf = keys.map((k) => `${k}=${JSON.stringify(settings[k])}`).join(' ');
    return [
      'Live Board voice log',
      `when: ${new Date().toString()}`,
      `browser: ${navigator.userAgent}`,
      `standalone (home-screen app): ${window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}`,
      `recogniser: ${window.SpeechRecognition ? 'SpeechRecognition' : window.webkitSpeechRecognition ? 'webkitSpeechRecognition' : 'none'}`,
      `settings: ${conf}`,
      `state now: listening=${this.listening} ready=${!!this.ready} want=${this.want} ignoringWhileClaudeSpeaks=${this.isMuted()} speaking=${this.isSpeaking()}`,
      '',
      ...(this.events || ['(no events yet)']),
    ].join('\n');
  }

  clearLog() {
    this.recentLog = []; this.events = []; this.t0 = Date.now(); }

  debug(msg) {
    this.log('note', msg);
    if (settings.voiceDebug) emit('voice-debug', msg);
  }

  static norm(s) {
    return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  }

  // Removes `prefix` (words already sent) from the start of `text`. Safari rewrites earlier words as it
  // goes ("very good" → "pretty good"), so besides an exact match this also accepts a close one.
  static strip(text, prefix) {
    if (!prefix || !text) return text;
    const norm = Voice.norm;
    const words = text.split(/\s+/).filter(Boolean);
    const pw = prefix.split(/\s+/).filter(Boolean);
    const n = pw.length;
    if (words.length >= n && norm(words.slice(0, n).join(' ')) === norm(prefix)) return words.slice(n).join(' ');
    if (norm(prefix).startsWith(norm(text))) return ''; // only part of what was already sent
    const tw = words.map(norm), pn = pw.map(norm);
    if (tw.length >= n) {
      const head = new Set(tw.slice(0, n + 2));
      const match = pn.filter((w) => head.has(w)).length;
      if (match / n >= 0.6) return words.slice(n).join(' ');
    } else {
      const ps = new Set(pn);
      if (tw.filter((w) => ps.has(w)).length / tw.length >= 0.8) return '';
    }
    return text;
  }

  current() {
    return `${this.heard} ${this.runText}`.replace(/\s+/g, ' ').trim();
  }

  // A fresh recogniser for every listening run. Safari keeps one transcript per run and keeps rewriting
  // it, so after each send a new run starts with an empty transcript; anything the old run still
  // reports is ignored (`mine()`), which is what stops earlier messages from being sent again.
  makeRec() {
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    const mine = () => r === this.rec;
    const runId = (this.runCounter = (this.runCounter || 0) + 1);
    const tag = () => `run ${runId}${mine() ? '' : ' (old, ignored)'}`;
    // Diagnostic log only. Wrapped so a logging problem can never stop the mic from starting.
    const hook = (ev, fn) => { try { r.addEventListener(ev, (e) => { try { fn(e); } catch {} }); } catch {} };
    for (const ev of ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch', 'end']) {
      hook(ev, () => this.log(ev, tag()));
    }
    hook('error', (e) => this.log('ERROR ' + e.error, `${tag()} ${e.message || ''}`));
    hook('result', (e) => {
      const n = e.results.length;
      let finals = 0, text = '';
      for (let i = 0; i < n; i++) { if (e.results[i].isFinal) finals++; text += e.results[i][0].transcript + ' '; }
      this.log('result', `${tag()} results=${n} final=${finals} resultIndex=${e.resultIndex} "${text.trim().slice(-60)}"`);
    });
    // "ready" = Safari is actually hearing audio (not just asked to start). Some iPads only signal it
    // through the first result, so that counts too.
    const ready = (why) => { if (!this.ready) { this.ready = true; this.debug(why); emit('mic', this.state()); } };
    r.onstart = () => { if (mine()) { this.lastActivity = Date.now(); ready('listening started'); } };
    r.onaudiostart = () => { if (mine()) { this.lastActivity = Date.now(); ready('microphone is on'); } };
    r.onresult = (e) => {
      if (!mine()) return;
      this.lastActivity = Date.now();
      ready('hearing you');
      // Rebuild from the whole result list each time: Safari re-sends and re-marks earlier words,
      // so appending piece by piece duplicates or drops them.
      this.lastResults = [];
      for (let i = 0; i < e.results.length; i++) this.lastResults.push({ t: e.results[i][0].transcript, final: e.results[i].isFinal });
      if (this.isMuted()) {
        // With headphones the mic can't hear Claude, so speaking means you want to interrupt it.
        if (settings.headphones && this.isSpeaking()) this.cancelSpeech();
        else { this.debug('ignored while Claude speaks'); return; } // most likely Claude's own voice
      }
      const text = this.lastResults.map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim();
      this.debug('heard: ' + text);
      let fresh;
      {
        // one continuous run: skip the finished phrases already sent (Safari numbers them), then any
        // still-changing words that were sent with them (compared loosely, since Safari rewrites)
        const sk = this.skip || { idx: 0, tail: '', all: '' };
        if (sk.idx === 0 || this.lastResults.length > sk.idx) {
          const rest = this.lastResults.slice(sk.idx).map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim();
          fresh = Voice.strip(rest, sk.tail);
        } else {
          // Safari is growing one phrase instead of starting a new one: remove what was sent, loosely
          fresh = Voice.strip(text, sk.all);
        }
      }
      if (this.lastSent && Date.now() - this.lastSentAt < 6000) fresh = Voice.strip(fresh, this.lastSent);
      // a new run re-delivering words already waiting in the bar (happens while you hold text in manual mode)
      if (this.heard && fresh) {
        fresh = Voice.strip(fresh, this.heard);
        const finalNow = [...e.results].every((r) => r.isFinal);
        if (fresh && finalNow && Date.now() - this.runStartedAt < 600 && Voice.norm(this.heard).endsWith(Voice.norm(fresh))) fresh = '';
      }
      this.runText = fresh;
      const shown = this.current();
      if (!shown) return; // nothing new: never show sent words again
      // Safari also re-reports the same words during silence: that isn't speech, so it mustn't restart
      // the "seconds of silence" countdown (otherwise automatic sending never happens).
      if (shown === this.lastShown) return;
      this.lastShown = shown;
      emit('interim', shown); // the bar only ever grows while you speak; it is never blanked mid-sentence
      if (settings.voiceSend !== 'manual') {
        clearTimeout(this.timer);
        const delay = Math.max(0.5, Math.min(15, Number(settings.voiceSendDelaySec) || 1.4));
        this.timer = setTimeout(() => this.flush(), delay * 1000);
      }
    };
    r.onend = () => {
      if (!mine()) return; // an old run we already replaced
      this.debug('listening run ended');
      this.listening = false;
      this.ready = false;
      // Safari ends runs on its own after pauses: keep unsent words for the next run
      if (this.runText) this.heard = this.current();
      this.runText = '';
      this.runSent = '';
      this.skip = null;
      this.lastResults = [];
      emit('mic', this.state());
      if (!this.want) return;
      if (TAP_ONLY) this.stoppedOnItsOwn('Safari ended the listening run');
      else setTimeout(() => this.startRec('run ended by Safari'), 250);
    };
    r.onerror = (e) => {
      if (!mine()) return;
      this.debug('error: ' + e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        this.listening = false; this.ready = false; this.rec = null; emit('mic', this.state());
        if (document.visibilityState !== 'visible') return; // the app was in the background: not a permission problem
        emit('voice-error', 'Safari is not allowing speech recognition. Allow the microphone (aA button in the address bar → Website Settings), and make sure Dictation is on (iPad Settings → General → Keyboard).');
      } else if (e.error === 'audio-capture') {
        // iOS took the microphone away (Control Center, a notification, Siri, another app...): the run ends next
        this.stopNoticeShown = true;
        emit('voice-notice', 'iOS muted the microphone (something else used the audio for a moment). Tap the mic to listen again.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        emit('voice-error', 'Speech recognition: ' + e.error);
      }
    };
    return r;
  }

  state() {
    return { listening: this.listening, ready: !!this.ready, want: this.want, speaking: this.isSpeaking() };
  }

  startRec(reason = 'unspecified') {
    this.log('app: start listening', `reason=${reason}${this.listening ? ' (skipped: already listening)' : ''}${document.visibilityState !== 'visible' ? ' page-hidden' : ''}`);
    if (!this.supported || this.listening) return;
    this.lastStartAttempt = Date.now();
    this.lastActivity = Date.now();
    this.rec = this.makeRec();
    this.runText = '';
    this.runSent = '';
    this.skip = null;
    this.lastResults = [];
    this.ready = false;
    this.runStartedAt = Date.now();
    // anything still speaking would hold iOS audio in playback mode and deafen the mic
    if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    try {
      this.rec.start();
      this.listening = true;
      this.retries = 0;
      emit('mic', this.state());
    } catch (err) {
      // Safari sometimes isn't ready to start again yet: retry a few times, then start over with a fresh recogniser
      this.debug('could not start: ' + (err?.name || '') + ' ' + (err?.message || err));
      this.rec = null;
      if (++this.retries <= 6) setTimeout(() => { if (this.want) this.startRec('retry after failed start'); }, 300 * this.retries);
      else { this.retries = 0; this.want = false; emit('mic', this.state()); emit('voice-error', 'Safari would not start listening. Tap the mic to try again.'); }
    }
  }

  stopRec(reason = 'unspecified') {
    this.log('app: stop listening', `reason=${reason}`);
    try { this.rec?.stop(); } catch {}
  }

  toggleContinuous() {
    this.want = !this.want;
    if (this.want) {
      if (this.listening) { const old = this.rec; this.rec = null; this.listening = false; try { old?.abort(); } catch {} }
      this.stopNoticeShown = false;
      this.startRec('mic tapped on');
    }
    else {
      // turning the mic off: auto mode sends what's left; manual mode keeps it in the bar for you to send
      if (settings.voiceSend === 'manual') { this.heard = this.current(); this.runSent = `${this.runSent} ${this.runText}`.trim(); this.runText = ''; this.showHeld(); }
      else this.flush();
      this.stopRec('mic tapped off');
    }
    emit('mic', this.state());
  }

  stopAll() {
    this.want = false;
    this.stopRec('voice input turned off in settings');
    emit('mic', this.state());
  }

  // After sending (or discarding) words: either start a fresh run, or keep the run and mark what was used.
  consumed(reason) {
    const res = this.lastResults || [];
    let idx = 0;
    while (idx < res.length && res[idx].final) idx++;
    this.skip = { idx, tail: res.slice(idx).map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim(), all: res.map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim() };
    this.log('app: marked as used', `reason=${reason} skip ${idx} finished phrase(s) + "${this.skip.tail.slice(0, 40)}"`);
  }

  // Listening stopped without you tapping (Safari ended it, or the app went to the background).
  // On iPad a restart without a tap would be deaf, so show the mic as off and say so.
  stoppedOnItsOwn(why) {
    if (this.runText) { this.heard = this.current(); this.runText = ''; this.showHeld(); } // keep unsent words
    this.want = false;
    this.listening = false;
    this.ready = false;
    try { this.rec?.abort(); } catch {}
    this.rec = null;
    this.log('app: listening stopped on its own', why);
    emit('mic', this.state());
    if (!this.stopNoticeShown) { this.stopNoticeShown = true; emit('voice-notice', 'Listening stopped. Tap the mic to listen again.'); }
  }

  showHeld() {
    const t = this.current();
    if (t) emit('interim', t);
  }

  // ↑ in the speech bar
  sendNow() {
    this.flush();
  }

  // ✕ in the speech bar: forget what was heard (and never show those words again)
  discardHeard() {
    clearTimeout(this.timer);
    this.runSent = `${this.runSent} ${this.runText}`.trim();
    this.heard = '';
    this.runText = '';
    this.lastShown = ''; emit('interim', '');
    this.consumed('discard/edit');
  }

  // ✎ in the speech bar: hand the text to the chat box instead of sending it
  takeHeard() {
    const t = this.current();
    this.discardHeard();
    return t;
  }

  // Sends everything heard so far, once: the bar hides and the same text appears in the panel.
  // Listening keeps running; words of this run that were sent are remembered so they never reappear.
  flush() {
    clearTimeout(this.timer);
    let text = this.current();
    this.runSent = `${this.runSent} ${this.runText}`.trim();
    this.heard = '';
    this.runText = '';
    this.lastShown = ''; emit('interim', '');
    if (!text) return;
    this.consumed('message sent'); // the next message never includes these words again
    if (text === this.lastSent && Date.now() - this.lastSentAt < 6000) return; // same words delivered twice
    this.lastSent = text;
    this.lastSentAt = Date.now();
    this.debug('sent: ' + text);
    this.log('app: message sent', `"${text.slice(0, 60)}"`);
    if (settings.wakeWord) {
      const w = settings.wakeWord.toLowerCase();
      const i = text.toLowerCase().indexOf(w);
      if (i < 0) return;
      text = text.slice(i + w.length).replace(/^[\s,.:!?]+/, '') || text;
    }
    emit('utterance', text);
  }

  // ---- speech out ----
  // iOS only lets a page speak later if it has spoken once from a tap. That first (silent) sentence is
  // played only when spoken replies are on and the mic is off: any sound while listening can make iOS
  // mute the microphone. Returns true once unlocked.
  unlock() {
    if (this.unlocked || !('speechSynthesis' in window)) return !!this.unlocked;
    if (!settings.voiceOut || this.listening) return false;
    this.unlocked = true;
    this.log('app: unlocking speech output (silent, from your tap)');
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.onend = () => this.log('app: unlock sound finished');
    speechSynthesis.speak(u);
    return true;
  }

  // iOS sometimes returns an empty voice list for a moment, and the reply would then switch to another
  // voice. So the last full list is remembered and used whenever the browser briefly reports none.
  voices() {
    if (!('speechSynthesis' in window)) return [];
    const list = speechSynthesis.getVoices();
    if (list.length) this.voiceCache = list;
    return list.length ? list : this.voiceCache || [];
  }

  speak(text, why = 'reply') {
    if (!('speechSynthesis' in window)) { this.log('app: cannot speak', 'this browser has no speech output'); return; }
    if (!text) return;
    const u = new SpeechSynthesisUtterance(String(text).replace(/[$\\{}_^]/g, ' '));
    u.rate = settings.speechRate || 1;
    u.volume = 1;
    const all = this.voices();
    const v = all.find((x) => x.name === settings.voiceName);
    // a remembered voice the browser no longer accepts must never stop the reply: fall back to its language
    if (v) { try { u.voice = v; } catch { this.log('app: voice not accepted, using its language', v.name); } }
    u.lang = v?.lang || navigator.language || 'en-US';
    // iOS sometimes leaves speech output paused, and then nothing is ever heard
    if (speechSynthesis.paused) { this.log('app: speech output was paused: resuming'); speechSynthesis.resume(); }
    const asked = Date.now();
    this.log('app: speak', `${why}, ${String(text).length} chars, voice=${v ? `${v.name} (${v.lang}${v.localService === false ? ', online' : ''})` : `default for ${u.lang}`}${settings.voiceName && !v ? ` [chosen voice "${settings.voiceName}" not available]` : ''}, ${all.length} voices, rate ${u.rate}, mic ${this.listening ? 'on' : 'off'}, unlocked=${!!this.unlocked}`);
    let started = false;
    setTimeout(() => { if (!started) this.log('app: speech output never started', `${((Date.now() - asked) / 1000).toFixed(1)} s after asking; still queued=${speechSynthesis.pending} speaking=${speechSynthesis.speaking}`); }, 3000);
    u.onstart = () => {
      started = true;
      // Listening keeps running (stopping and restarting it is what leaves iPad Safari deaf).
      // Instead, whatever the mic picks up while Claude talks is ignored: it is mostly Claude's own voice.
      this.mutedSpeech = true;
      this.log(this.listening ? 'app: Claude speaking (mic stays on, words ignored meanwhile)' : 'app: Claude speaking', `"${String(text).slice(0, 40)}"`);
      emit('speaking', true);
    };
    const done = (e) => {
      if (e?.type === 'error') this.log('ERROR speech output', `${e.error || 'unknown'} after ${((Date.now() - asked) / 1000).toFixed(1)} s`);
      else this.log('app: speech output ended', `after ${((Date.now() - asked) / 1000).toFixed(1)} s (about ${Math.round(String(text).length / 14)} s expected)`);
      setTimeout(() => {
        if (speechSynthesis.speaking) return;
        emit('speaking', false);
        this.log('app: Claude finished speaking');
        this.endMute();
      }, 50);
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  // Settings → Voice → Test voice. Runs from a tap, which is what iOS needs to allow speech output.
  testVoice() {
    this.unlocked = true;
    speechSynthesis.cancel?.();
    this.speak('This is Live Board. If you can hear me, speech output works.', 'test button');
  }

  isSpeaking() {
    return 'speechSynthesis' in window && speechSynthesis.speaking;
  }

  cancelSpeech() {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    emit('speaking', false);
    this.endMute(0);
  }

  // Still ignoring the mic? (while Claude talks, and a moment after, for the echo of its last words)
  isMuted() {
    if (this.mutedSpeech) {
      // iOS sometimes never reports that speaking finished: stop ignoring the mic once it is actually quiet
      if (this.isSpeaking()) this.quietSince = 0;
      else {
        this.quietSince ||= Date.now();
        if (Date.now() - this.quietSince > 700) {
          this.quietSince = 0;
          this.log('app: speech output ended without notice');
          emit('speaking', false);
          this.endMute(0);
        }
      }
    }
    return !!this.mutedSpeech || Date.now() < (this.muteUntil || 0);
  }

  // Claude stopped talking: ignore the mic a little longer, then mark everything heard so far as used,
  // so Claude's own words never turn up in your next message.
  endMute(tailMs = 800) {
    if (!this.mutedSpeech) return;
    this.mutedSpeech = false;
    this.muteUntil = Date.now() + tailMs;
    clearTimeout(this.muteTimer);
    const markUsed = () => {
      if (this.listening) this.consumed('Claude finished speaking');
      this.runText = ''; this.lastShown = '';
    };
    if (tailMs > 0) this.muteTimer = setTimeout(markUsed, tailMs);
    else markUsed();
  }
}

export const voice = new Voice();
// fill the voice list early (iOS loads it lazily) and keep it up to date
if ('speechSynthesis' in window) {
  voice.voices();
  try { speechSynthesis.addEventListener('voiceschanged', () => voice.voices()); } catch {}
}

// Page visibility changes affect Safari's recogniser, so they go in the voice log too.
// Safari stops listening when the app goes to the background (and can't restart it there), so the mic is
// switched off cleanly and you tap it again when you are back.
document.addEventListener('visibilitychange', () => {
  voice.log('page ' + document.visibilityState);
  if (document.visibilityState === 'hidden' && voice.want) {
    voice.stopNoticeShown = true; // one clear message when you come back, not now
    voice.stoppedOnItsOwn('app went to the background');
    voice.backgrounded = true;
  } else if (document.visibilityState === 'visible' && voice.backgrounded) {
    voice.backgrounded = false;
    emit('voice-notice', 'The mic switched off while the app was in the background. Tap it to listen again.');
  }
});
window.addEventListener('pagehide', () => voice.log('page hide'));
