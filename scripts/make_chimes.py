"""Synthesizes Hangar's notification chimes into public/sounds/<style>-<kind>.wav. Needs numpy.

kinds:  done     a reply or task finished (rising, bright)
        waiting  Claude is waiting for you (lower, repeated)
styles: bell     soft glass-bell partials (the default)
        marimba  short wooden mallet tones
        glass    high, pure and very quiet
"""
import os
import wave

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "sounds")

# (multiple of the base frequency, amplitude, decay per second)
TIMBRES = {
    "bell": [(1.0, 1.0, 3.2), (2.0, 0.35, 5.0), (2.76, 0.18, 7.0), (5.4, 0.06, 10.0)],
    "marimba": [(1.0, 1.0, 7.0), (3.93, 0.25, 16.0), (9.2, 0.05, 30.0)],
    "glass": [(1.0, 1.0, 2.2), (2.0, 0.12, 4.0)],
}
LEVEL = {"bell": 0.42, "marimba": 0.45, "glass": 0.28}
# (start s, frequency Hz, length s, relative amplitude)
NOTES = {
    "bell": {"done": [(0.0, 659.25, 1.2, 1.0), (0.13, 987.77, 1.25, 0.9)],
             "waiting": [(0.0, 440.0, 0.9, 1.0), (0.32, 440.0, 1.1, 0.85)]},
    "marimba": {"done": [(0.0, 523.25, 0.6, 1.0), (0.11, 659.25, 0.6, 0.9), (0.22, 783.99, 0.8, 0.9)],
                "waiting": [(0.0, 392.0, 0.6, 1.0), (0.28, 392.0, 0.7, 0.8)]},
    "glass": {"done": [(0.0, 1318.5, 1.3, 1.0), (0.16, 1760.0, 1.4, 0.8)],
              "waiting": [(0.0, 880.0, 1.2, 1.0), (0.4, 880.0, 1.3, 0.8)]},
}


def tone(style: str, freq: float, dur: float, amp: float) -> np.ndarray:
    t = np.arange(int(SR * dur)) / SR
    sig = sum(a * np.sin(2 * np.pi * freq * m * t) * np.exp(-d * t) for m, a, d in TIMBRES[style])
    return amp * sig * np.minimum(1.0, t / 0.006)       # 6 ms attack: no click


def render(style: str, kind: str) -> np.ndarray:
    notes = NOTES[style][kind]
    total = max(s + d for s, _, d, _ in notes) + 0.05
    out = np.zeros(int(SR * total))
    for start, freq, dur, amp in notes:
        s = tone(style, freq, dur, amp)
        i = int(SR * start)
        out[i:i + len(s)] += s[: len(out) - i]
    return out / (np.max(np.abs(out)) or 1.0) * LEVEL[style]


def save(name: str, sig: np.ndarray) -> None:
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((sig * 32767).astype("<i2").tobytes())
    print("wrote", name, f"{len(sig) / SR:.2f}s")


for style in NOTES:
    for kind in ("done", "waiting"):
        save(f"{style}-{kind}.wav", render(style, kind))
