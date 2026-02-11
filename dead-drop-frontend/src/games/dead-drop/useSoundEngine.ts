import { useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';

type TemperatureZone = 'FOUND' | 'HOT' | 'WARM' | 'COOL' | 'COLD';

export function useSoundEngine() {
  const [enabled, setEnabled] = useState(false);
  const reverbRef = useRef<Tone.Reverb | null>(null);
  const ambientSequenceRef = useRef<Tone.Sequence | null>(null);
  const ambientSynthRef = useRef<Tone.Synth | null>(null);
  const bassDroneRef = useRef<Tone.Synth | null>(null);

  // Initialize Tone audio context and effects on mount
  useEffect(() => {
    const setupAudio = async () => {
      if (!reverbRef.current) {
        // Create reverb effect
        const reverb = new Tone.Reverb({
          decay: 6,
          wet: 0.7,
        }).toDestination();
        reverbRef.current = reverb;

        // Create ambient synth (triangle wave)
        const ambientSynth = new Tone.Synth({
          oscillator: { type: 'triangle' },
          envelope: {
            attack: 0.1,
            decay: 0.2,
            sustain: 0.3,
            release: 0.5,
          },
        }).connect(reverb);
        ambientSynthRef.current = ambientSynth;

        // Create bass drone synth (sawtooth wave)
        const bassDrone = new Tone.Synth({
          oscillator: { type: 'sawtooth' },
          envelope: {
            attack: 2,
            decay: 1,
            sustain: 0.5,
            release: 2,
          },
        }).connect(reverb);
        bassDrone.volume.value = -25;
        bassDroneRef.current = bassDrone;
      }
    };

    setupAudio();

    return () => {
      // Cleanup
    };
  }, []);

  const ensureAudioStarted = async () => {
    if (Tone.Synth.getDefaults().context.state === 'suspended') {
      await Tone.start();
    }
  };

  const playPingResult = async (zone: TemperatureZone) => {
    if (!enabled) return;
    await ensureAudioStarted();

    const freqMap: Record<TemperatureZone, number> = {
      COLD: 180,
      COOL: 320,
      WARM: 520,
      HOT: 800,
      FOUND: 1200,
    };

    const freq = freqMap[zone];
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.01,
        decay: 0.8,
        sustain: 0,
        release: 1.5,
      },
    }).connect(reverbRef.current!);

    if (zone === 'FOUND') {
      // Rapid ascending sweep + alarm pulse
      synth.triggerAttackRelease(freq, '8n', Tone.now());
      synth.frequency.setValueAtTime(freq, Tone.now());
      synth.frequency.exponentialRampToValueAtTime(freq * 2, Tone.now() + 0.15);

      // Repeat ping 3 times
      for (let i = 1; i < 3; i++) {
        const time = Tone.now() + i * 0.2;
        synth.triggerAttackRelease('8n', time);
      }
    } else if (zone === 'HOT') {
      // 3 rapid repeats for hot
      for (let i = 0; i < 3; i++) {
        const time = Tone.now() + i * 0.15;
        synth.triggerAttackRelease(freq, '16n', time);
      }
    } else {
      // Single ping for other zones
      synth.triggerAttackRelease(freq, '4n', Tone.now());
    }

    // Clean up synth after it finishes
    setTimeout(() => synth.dispose(), 3000);
  };

  const playCommitSecret = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // Lock-click: percussive noise + electronic seal tone
    const noiseOsc = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: {
        attack: 0.01,
        decay: 0.15,
        sustain: 0,
        release: 0.1,
      },
    }).connect(reverbRef.current!);

    const sealTone = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.05,
        decay: 0.3,
        sustain: 0,
        release: 0.2,
      },
    }).connect(reverbRef.current!);

    noiseOsc.triggerAttackRelease(600, '16n', Tone.now());
    sealTone.triggerAttackRelease(1000, '8n', Tone.now() + 0.05);

    setTimeout(() => {
      noiseOsc.dispose();
      sealTone.dispose();
    }, 1000);
  };

  const playLobbyOpened = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // Two-tone radio acknowledgment blip
    const tone1 = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.01,
        decay: 0.2,
        sustain: 0,
        release: 0.1,
      },
    }).connect(reverbRef.current!);

    const tone2 = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.01,
        decay: 0.2,
        sustain: 0,
        release: 0.1,
      },
    }).connect(reverbRef.current!);

    tone1.triggerAttackRelease(800, '16n', Tone.now());
    tone2.triggerAttackRelease(1200, '16n', Tone.now() + 0.12);

    setTimeout(() => {
      tone1.dispose();
      tone2.dispose();
    }, 1000);
  };

  const playOpponentJoined = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // Ascending two-note alert chime
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.05,
        decay: 0.3,
        sustain: 0,
        release: 0.2,
      },
    }).connect(reverbRef.current!);

    synth.triggerAttackRelease(600, '8n', Tone.now());
    synth.triggerAttackRelease(900, '8n', Tone.now() + 0.25);

    setTimeout(() => synth.dispose(), 1000);
  };

  const playMyTurn = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // Short double-beep notification
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.02,
        decay: 0.15,
        sustain: 0,
        release: 0.1,
      },
    }).connect(reverbRef.current!);

    synth.triggerAttackRelease(1000, '32n', Tone.now());
    synth.triggerAttackRelease(1000, '32n', Tone.now() + 0.2);

    setTimeout(() => synth.dispose(), 800);
  };

  const playVictory = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // 4-note ascending spy stinger
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.05,
        decay: 0.4,
        sustain: 0,
        release: 0.3,
      },
    }).connect(reverbRef.current!);

    const notes = [660, 880, 1100, 1320];
    notes.forEach((note, i) => {
      synth.triggerAttackRelease(note, '8n', Tone.now() + i * 0.25);
    });

    setTimeout(() => synth.dispose(), 2000);
  };

  const playDefeat = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // 3-note descending stinger
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.05,
        decay: 0.4,
        sustain: 0,
        release: 0.3,
      },
    }).connect(reverbRef.current!);

    const notes = [1100, 800, 550];
    notes.forEach((note, i) => {
      synth.triggerAttackRelease(note, '8n', Tone.now() + i * 0.25);
    });

    setTimeout(() => synth.dispose(), 1500);
  };

  const playTimeout = async () => {
    if (!enabled) return;
    await ensureAudioStarted();

    // Flat buzzer tone
    const synth = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: {
        attack: 0.02,
        decay: 0.3,
        sustain: 0.1,
        release: 0.2,
      },
    }).connect(reverbRef.current!);

    synth.triggerAttackRelease(400, '4n', Tone.now());

    setTimeout(() => synth.dispose(), 1000);
  };

  const startAmbient = async (force = false) => {
    if ((!enabled && !force) || ambientSequenceRef.current) return;
    await ensureAudioStarted();

    // Bass drone
    bassDroneRef.current?.triggerAttack('A1', Tone.now());

    // Ambient arpeggio sequence
    const notes = ['A2', 'C3', 'E3', 'G3', 'A3', null, null, null]; // 50% sparse
    const synth = ambientSynthRef.current!;

    const sequence = new Tone.Sequence(
      (time, note) => {
        if (note) {
          synth.triggerAttackRelease(note, '8n', time);
        }
      },
      notes,
      '8n'
    );

    // Set tempo to 90 BPM
    Tone.Transport.bpm.value = 90;

    sequence.start(Tone.now());
    sequence.loop = true;
    Tone.Transport.start();

    ambientSequenceRef.current = sequence;
  };

  const stopAmbient = async () => {
    if (ambientSequenceRef.current) {
      ambientSequenceRef.current.stop();
      ambientSequenceRef.current.dispose();
      ambientSequenceRef.current = null;
    }

    if (bassDroneRef.current) {
      bassDroneRef.current.triggerRelease(Tone.now());
    }

    // Keep transport running for sound effects
    if (Tone.Transport.state === 'stopped') {
      Tone.Transport.start();
    }
  };

  const toggle = async () => {
    await ensureAudioStarted();
    const newEnabled = !enabled;
    setEnabled(newEnabled);

    if (!newEnabled) {
      // Muting - stop ambient
      await stopAmbient();
    } else {
      // Unmuting - start ambient (force=true bypasses stale enabled check)
      await startAmbient(true);
    }
  };

  return {
    enabled,
    toggle,
    playPingResult,
    playCommitSecret,
    playLobbyOpened,
    playOpponentJoined,
    playMyTurn,
    playVictory,
    playDefeat,
    playTimeout,
    startAmbient,
    stopAmbient,
  };
}
