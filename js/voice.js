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
      if (now - this.quietSince > 1500) { this.debug('speech output ended without notice: listening again'); this.pausedForSpeech = false; this.quietSince = 0; this.startRec(); }
      return;
    }
    if (!this.listening) {
      if (now - this.lastStartAttempt > 2500) { this.debug('mic was meant to be on but was not listening: restarting'); this.startRec(); }
      return;
    }
    // listening, nothing waiting, and no sign of life for a while: the run may be dead, start a fresh one
    const idle = Math.max(4, Number(settings.voiceWatchdogSec) || 8) * 1000;
    if (!this.runText && now - this.lastActivity > idle) { this.debug('no sound for a while: refreshing the listening run'); this.freshRun(); }
  }

  debug(msg) {
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
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + ' ';
      text = text.trim();
      this.debug('heard: ' + text);
      // drop words of this run that were already sent, and a re-delivery of the last message
      let fresh = Voice.strip(text, this.runSent);
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
      emit('mic', this.state());
      if (this.pushReleased) {
        this.pushReleased = false;
        if (settings.voiceSend === 'manual') this.showHeld(); else this.flush();
      } else if (this.want && !this.pausedForSpeech) setTimeout(() => this.startRec(), 250);
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

  startRec() {
    if (!this.supported || this.listening) return;
    this.lastStartAttempt = Date.now();
    this.lastActivity = Date.now();
    this.rec = this.makeRec();
    this.runText = '';
    this.runSent = '';
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
      this.debug('could not start: ' + (err?.message || err));
      this.rec = null;
      if (++this.retries <= 6) setTimeout(() => { if (this.want || this.pushing) this.startRec(); }, 300 * this.retries);
      else { this.retries = 0; this.want = false; emit('mic', this.state()); emit('voice-error', 'Safari would not start listening. Tap the mic to try again.'); }
    }
  }

  stopRec() {
    try { this.rec?.stop(); } catch {}
  }

  toggleContinuous() {
    this.want = !this.want;
    if (this.want) this.startRec();
    else {
      // turning the mic off: auto mode sends what's left; manual mode keeps it in the bar for you to send
      if (settings.voiceSend === 'manual') { this.heard = this.current(); this.runSent = `${this.runSent} ${this.runText}`.trim(); this.runText = ''; this.showHeld(); }
      else this.flush();
      this.stopRec();
    }
    emit('mic', this.state());
  }

  stopAll() {
    this.want = false;
    this.stopRec();
    emit('mic', this.state());
  }

  pushStart() {
    if (settings.voiceSend !== 'manual') this.heard = ''; // manual mode: each hold adds to what's waiting
    this.want = false;
    this.pushing = true;
    this.cancelSpeech();
    this.startRec();
  }

  pushEnd() {
    this.pushing = false;
    this.pushReleased = true;
    this.stopRec();
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      if (this.pushReleased) {
        this.pushReleased = false;
        if (settings.voiceSend === 'manual') this.showHeld(); else this.flush();
      }
    }, 1500);
  }

  // Ends the current listening run and starts a new one with an empty transcript.
  freshRun() {
    if (!this.listening || !this.want) return; // hold-to-talk runs end on release anyway
    if (this.runText) { this.heard = this.current(); this.runText = ''; } // keep anything not yet sent
    const old = this.rec;
    this.rec = null;
    this.listening = false;
    this.ready = false;
    try { old?.abort(); } catch {}
    this.debug('starting a fresh listening run');
    setTimeout(() => { if (this.want && !this.listening && !this.pausedForSpeech) this.startRec(); }, 300);
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
    this.freshRun();
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
    this.freshRun(); // the next message starts from an empty transcript
    if (text === this.lastSent && Date.now() - this.lastSentAt < 6000) return; // same words delivered twice
    this.lastSent = text;
    this.lastSentAt = Date.now();
    this.debug('sent: ' + text);
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
    u.onend = () => { if (this.want && this.listening) this.freshRun(); };
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
        this.stopRec();
      }
      emit('speaking', true);
    };
    const done = () => {
      setTimeout(() => {
        if (speechSynthesis.speaking) return;
        emit('speaking', false);
        if (this.pausedForSpeech) {
          this.pausedForSpeech = false;
          if (this.want) this.startRec();
        } else if (this.want && this.listening) this.freshRun(); // with headphones: listening may have been knocked out
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
      if (this.want) this.startRec();
    }
  }
}

export const voice = new Voice();
