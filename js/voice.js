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
    this.runText = ''; // everything the current run has recognised (final + still-changing words)
    this.discard = false; // ignore late results from a run whose words were already sent
    this.pausedForSpeech = false;
    this.pushReleased = false;
    this.lastSent = '';
    this.lastSentAt = 0;
  }

  // Safari sometimes re-delivers the words you just said in its next listening run. Drop them.
  withoutJustSent(text) {
    if (!this.lastSent || Date.now() - this.lastSentAt > 6000) return text;
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const words = text.split(/\s+/).filter(Boolean);
    const n = this.lastSent.split(/\s+/).filter(Boolean).length;
    if (words.length >= n && norm(words.slice(0, n).join(' ')) === norm(this.lastSent)) return words.slice(n).join(' ');
    if (norm(this.lastSent).startsWith(norm(text))) return ''; // a partial repeat of what was sent
    return text;
  }

  current() {
    return `${this.heard} ${this.runText}`.replace(/\s+/g, ' ').trim();
  }

  makeRec() {
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onstart = () => { this.runText = ''; this.discard = false; };
    r.onresult = (e) => {
      if (this.discard) return;
      if (this.isSpeaking()) this.cancelSpeech(); // barge-in: you talk, it stops
      // Rebuild from the whole result list each time: Safari re-sends and re-marks earlier words,
      // so appending piece by piece duplicates or drops them.
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + ' ';
      this.runText = this.withoutJustSent(text.trim());
      const shown = this.current();
      if (!shown) return; // only words that were already sent: never show them again
      emit('interim', shown); // the bar only ever grows while you speak; it is never blanked mid-sentence
      if (settings.voiceIn === 'continuous') {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 1400);
      }
    };
    r.onend = () => {
      this.listening = false;
      // Safari ends runs on its own after pauses; keep what it heard for the next run
      if (!this.discard && this.runText) this.heard = this.current();
      this.runText = '';
      emit('mic', this.state());
      if (this.pushReleased) { this.pushReleased = false; this.flush(); }
      else if (this.want && !this.pausedForSpeech) setTimeout(() => this.startRec(), 200);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        emit('voice-error', 'Microphone permission was denied. Allow it in your browser settings.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        emit('voice-error', 'Speech recognition: ' + e.error);
      }
    };
    return r;
  }

  state() {
    return { listening: this.listening, want: this.want, mode: settings.voiceIn, speaking: this.isSpeaking() };
  }

  startRec() {
    if (!this.supported || this.listening) return;
    this.rec ||= this.makeRec();
    try {
      this.rec.start();
      this.listening = true;
      emit('mic', this.state());
    } catch {}
  }

  stopRec() {
    try { this.rec?.stop(); } catch {}
  }

  toggleContinuous() {
    this.want = !this.want;
    if (this.want) this.startRec();
    else { this.flush(); this.stopRec(); }
    emit('mic', this.state());
  }

  stopAll() {
    this.want = false;
    this.stopRec();
    emit('mic', this.state());
  }

  pushStart() {
    this.heard = '';
    this.runText = '';
    this.want = false;
    this.cancelSpeech();
    this.startRec();
  }

  pushEnd() {
    this.pushReleased = true;
    this.stopRec();
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      if (this.pushReleased) { this.pushReleased = false; this.flush(); }
    }, 1500);
  }

  // Sends everything heard so far, once: the bar hides and the same text appears in the panel.
  flush() {
    clearTimeout(this.timer);
    let text = this.current();
    this.heard = '';
    this.runText = '';
    emit('interim', '');
    if (!text) return;
    // Start a fresh run so Safari can't re-deliver the words just sent (that caused the re-flash).
    if (this.listening && this.want) {
      this.discard = true;
      try { this.rec.abort(); } catch {}
    }
    if (text === this.lastSent && Date.now() - this.lastSentAt < 5000) return; // same words delivered twice
    this.lastSent = text;
    this.lastSentAt = Date.now();
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
    this.unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
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
        }
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
