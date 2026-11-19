// Voice in (browser speech recognition) and voice out (speech synthesis), with barge-in.
import { settings } from './settings.js';
import { emit } from './bus.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

class Voice {
  constructor() {
    this.supported = !!SR;
    this.listening = false;
    this.want = false; // continuous mode is on
    this.final = '';
    this.pausedForSpeech = false;
    this.pushReleased = false;
  }

  makeRec() {
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      if (this.isSpeaking()) this.cancelSpeech(); // barge-in: you talk, it stops
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.final += res[0].transcript + ' ';
        else interim += res[0].transcript;
      }
      emit('interim', (this.final + interim).trim());
      if (settings.voiceIn === 'continuous') {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 1400);
      }
    };
    r.onend = () => {
      this.listening = false;
      emit('mic', this.state());
      if (this.pushReleased) { this.pushReleased = false; this.flush(); }
      else if (this.want && !this.pausedForSpeech) setTimeout(() => this.startRec(), 250);
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
    else { this.stopRec(); this.flush(); }
    emit('mic', this.state());
  }

  stopAll() {
    this.want = false;
    this.stopRec();
    emit('mic', this.state());
  }

  pushStart() {
    this.final = '';
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

  flush() {
    clearTimeout(this.timer);
    let text = this.final.trim();
    this.final = '';
    emit('interim', '');
    if (!text) return;
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
