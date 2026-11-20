// Voice in (browser speech recognition) and voice out (speech synthesis), with barge-in.
import { settings } from './settings.js';
import { emit } from './bus.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

class Voice {
  constructor() {
    this.supported = !!SR;
    this.listening = false;
    this.want = false; // continuous mode is on
    this.heard = ''; // text from earlier recognition runs that hasn't been sent yet
    this.runText = ''; // what the current run has recognised and not yet sent
    this.runSent = ''; // what the current run recognised that was already sent
    this.pausedForSpeech = false;
    this.pushReleased = false;
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
    if (this.pausedForSpeech) {
      // waiting for Claude's voice to finish: resume if it has actually stopped
      if (this.isSpeaking()) { this.quietSince = 0; return; }
      this.quietSince ||= now;
      if (now - this.quietSince > 1500) { this.debug('speech output ended without notice: listening again'); this.pausedForSpeech = false; this.quietSince = 0; this.startRec('watchdog: speech output ended without notice'); }
      return;
    }
    if (!this.listening) {
      if (now - this.lastStartAttempt > 2500) { this.debug('mic was meant to be on but was not listening: restarting'); this.startRec('watchdog: not listening'); }
      return;
    }
    // listening, nothing waiting, and no sign of life for a while: the run may be dead, start a fresh one
    const sec = Number(settings.voiceWatchdogSec) || 0;
    if (sec > 0 && !this.runText && now - this.lastActivity > Math.max(4, sec) * 1000) { this.debug('no sound for a while: refreshing the listening run'); this.freshRun('watchdog: no sound'); }
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
    const keys = ['voiceIn', 'voiceSend', 'voiceSendDelaySec', 'voiceFreshRuns', 'voiceWatchdogSec', 'headphones', 'voiceOut', 'narration', 'liveSpeak', 'wakeWord'];
    const conf = keys.map((k) => `${k}=${JSON.stringify(settings[k])}`).join(' ');
    return [
      'Live Board voice log',
      `when: ${new Date().toString()}`,
      `browser: ${navigator.userAgent}`,
      `standalone (home-screen app): ${window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}`,
      `recogniser: ${window.SpeechRecognition ? 'SpeechRecognition' : window.webkitSpeechRecognition ? 'webkitSpeechRecognition' : 'none'}`,
      `settings: ${conf}`,
      `state now: listening=${this.listening} ready=${!!this.ready} want=${this.want} pausedForSpeech=${this.pausedForSpeech} speaking=${this.isSpeaking()}`,
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
    const ready = (why) => { if (!this.ready) { this.ready = true; this.debug(why); emit('mic', this.state()); this.unlockSoon(); } };
    r.onstart = () => { if (mine()) { this.lastActivity = Date.now(); ready('listening started'); } };
    r.onaudiostart = () => { if (mine()) { this.lastActivity = Date.now(); ready('microphone is on'); } };
    r.onresult = (e) => {
      if (!mine()) return;
      this.lastActivity = Date.now();
      ready('hearing you');
      if (this.isSpeaking()) this.cancelSpeech(); // barge-in: you talk, it stops
      // Rebuild from the whole result list each time: Safari re-sends and re-marks earlier words,
      // so appending piece by piece duplicates or drops them.
      this.lastResults = [];
      for (let i = 0; i < e.results.length; i++) this.lastResults.push({ t: e.results[i][0].transcript, final: e.results[i].isFinal });
      const text = this.lastResults.map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim();
      this.debug('heard: ' + text);
      let fresh;
      if (settings.voiceFreshRuns) {
        // fresh-run mode: the run only contains this message (plus late re-deliveries, stripped below)
        fresh = Voice.strip(text, this.runSent);
      } else {
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
      if (settings.voiceIn === 'continuous' && settings.voiceSend !== 'manual') {
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
      if (this.pushReleased) {
        this.pushReleased = false;
        if (settings.voiceSend === 'manual') this.showHeld(); else this.flush();
      } else if (this.want && !this.pausedForSpeech) setTimeout(() => this.startRec('run ended by Safari'), 250);
    };
    r.onerror = (e) => {
      if (!mine()) return;
      this.debug('error: ' + e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        emit('voice-error', 'Safari is not allowing speech recognition. Allow the microphone (aA button in the address bar → Website Settings), and make sure Dictation is on (iPad Settings → General → Keyboard).');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        emit('voice-error', 'Speech recognition: ' + e.error);
      }
    };
    return r;
  }

  state() {
    return { listening: this.listening, ready: !!this.ready, want: this.want, mode: settings.voiceIn, speaking: this.isSpeaking() };
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
      if (++this.retries <= 6) setTimeout(() => { if (this.want || this.pushing) this.startRec('retry after failed start'); }, 300 * this.retries);
      else { this.retries = 0; this.want = false; emit('mic', this.state()); emit('voice-error', 'Safari would not start listening. Tap the mic to try again.'); }
    }
  }

  stopRec(reason = 'unspecified') {
    this.log('app: stop listening', `reason=${reason}`);
    try { this.rec?.stop(); } catch {}
  }

  toggleContinuous() {
    this.want = !this.want;
    if (this.want) this.startRec('mic tapped on');
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

  pushStart() {
    if (settings.voiceSend !== 'manual') this.heard = ''; // manual mode: each hold adds to what's waiting
    this.want = false;
    this.pushing = true;
    this.cancelSpeech();
    this.startRec('mic held');
  }

  pushEnd() {
    this.pushing = false;
    this.pushReleased = true;
    this.stopRec('mic released');
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      if (this.pushReleased) {
        this.pushReleased = false;
        if (settings.voiceSend === 'manual') this.showHeld(); else this.flush();
      }
    }, 1500);
  }

  // After sending (or discarding) words: either start a fresh run, or keep the run and mark what was used.
  consumed(reason) {
    if (settings.voiceFreshRuns) return this.freshRun(reason);
    const res = this.lastResults || [];
    let idx = 0;
    while (idx < res.length && res[idx].final) idx++;
    this.skip = { idx, tail: res.slice(idx).map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim(), all: res.map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim() };
    this.log('app: marked as used', `reason=${reason} skip ${idx} finished phrase(s) + "${this.skip.tail.slice(0, 40)}"`);
  }

  // Ends the current listening run and starts a new one with an empty transcript.
  freshRun(reason = 'unspecified') {
    if (!this.listening || !this.want) return; // hold-to-talk runs end on release anyway
    if (this.runText) { this.heard = this.current(); this.runText = ''; } // keep anything not yet sent
    const old = this.rec;
    this.rec = null;
    this.listening = false;
    this.ready = false;
    this.log('app: abort run', `reason=${reason}`);
    try { old?.abort(); } catch {}
    this.debug('starting a fresh listening run');
    setTimeout(() => { if (this.want && !this.listening && !this.pausedForSpeech) this.startRec('fresh run after ' + reason); }, 300);
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
    if (settings.voiceIn === 'continuous' && settings.wakeWord) {
      const w = settings.wakeWord.toLowerCase();
      const i = text.toLowerCase().indexOf(w);
      if (i < 0) return;
      text = text.slice(i + w.length).replace(/^[\s,.:!?]+/, '') || text;
    }
    emit('utterance', text);
  }

  // ---- speech out ----
  unlock() {
    if (this.unlocked || !('speechSynthesis' in window)) return;
    if (this.listening && !this.ready) return; // never while the mic is still starting up
    this.unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    // playing audio can switch iOS out of recording mode: start a fresh listening run afterwards
    u.onend = () => { this.log('app: unlock sound finished'); if (this.want && this.listening) this.freshRun('unlock sound'); };
    speechSynthesis.speak(u);
  }

  // Once the mic is up, unlock speech output in the background so replies can be spoken.
  unlockSoon() {
    if (this.unlocked) return;
    setTimeout(() => { if (!this.isSpeaking()) this.unlock(); }, 1500);
  }

  voices() {
    return 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  }

  speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    const u = new SpeechSynthesisUtterance(String(text).replace(/[$\\{}_^]/g, ' '));
    u.rate = settings.speechRate || 1;
    const v = this.voices().find((x) => x.name === settings.voiceName);
    if (v) u.voice = v;
    u.lang = v?.lang || navigator.language || 'en-US';
    u.onstart = () => {
      // Without headphones the mic would hear the AI, so pause listening while it talks.
      if (!settings.headphones && this.listening && this.want) {
        this.pausedForSpeech = true;
        this.stopRec('pausing while Claude speaks');
      }
      this.log('app: Claude speaking', `"${String(text).slice(0, 40)}"`);
      emit('speaking', true);
    };
    const done = () => {
      setTimeout(() => {
        if (speechSynthesis.speaking) return;
        emit('speaking', false);
        this.log('app: Claude finished speaking');
        if (this.pausedForSpeech) {
          this.pausedForSpeech = false;
          if (this.want) this.startRec('Claude finished speaking');
        } else if (this.want && this.listening) this.freshRun('spoken reply finished'); // with headphones: listening may have been knocked out
      }, 50);
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  isSpeaking() {
    return 'speechSynthesis' in window && speechSynthesis.speaking;
  }

  cancelSpeech() {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    emit('speaking', false);
    if (this.pausedForSpeech) {
      this.pausedForSpeech = false;
      if (this.want) this.startRec('speech cancelled');
    }
  }
}

export const voice = new Voice();

// Page visibility changes affect Safari's recogniser, so they go in the voice log too.
document.addEventListener('visibilitychange', () => voice.log('page ' + document.visibilityState));
window.addEventListener('pagehide', () => voice.log('page hide'));
