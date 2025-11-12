#!/usr/bin/env python3
"""
mic_stream_socketio.py

Usage examples (Windows cmd):
  python python\mic_stream_socketio.py --server http://localhost:3000 --room test

PowerShell:
  python .\python\mic_stream_socketio.py --server http://localhost:3000 --room test

Install dependencies:
  pip install sounddevice numpy "python-socketio[client]"
"""

import argparse
import os
import sys
import time
import base64
import queue
import threading
import numpy as np
import sounddevice as sd
import socketio

# ----- CLI / Configuration -----
parser = argparse.ArgumentParser(description="Stream microphone to Socket.IO server as base64 int16 PCM")
parser.add_argument("--server", "-s", default=os.getenv("SERVER_URL", "http://localhost:3000"),
                    help="Socket.IO server URL (e.g. http://localhost:3000)")
parser.add_argument("--room", "-r", default=os.getenv("ROOM_CODE", "test-room"),
                    help="Room code to join")
parser.add_argument("--name", "-n", default=os.getenv("NAME", "VSCode-Mic"),
                    help="Sender name")
parser.add_argument("--rate", default=int(os.getenv("SAMPLE_RATE", "16000")), type=int,
                    help="Sample rate (Hz)")
parser.add_argument("--channels", default=int(os.getenv("CHANNELS", "1")), type=int,
                    help="Number of channels (1 = mono)")
parser.add_argument("--blocksize", default=int(os.getenv("BLOCKSIZE", "1024")), type=int,
                    help="Frames per callback block")
args = parser.parse_args()

SERVER_URL = args.server
ROOM_CODE   = args.room
NAME        = args.name
SAMPLE_RATE = args.rate
CHANNELS    = args.channels
BLOCKSIZE   = args.blocksize
DTYPE       = 'int16'

# ----- Globals -----
sio = socketio.Client()  # do NOT pass reconnect kwarg here; python-socketio handles reconnection internally
is_muted = False
running = True
send_q = queue.Queue(maxsize=64)

# ----- Socket.IO events -----
@sio.event
def connect():
    print("🔗 Connected to signaling server", flush=True)
    try:
        sio.emit("join-room", {"room": ROOM_CODE, "name": NAME}, callback=lambda res: print("JOIN:", res, flush=True))
    except Exception:
        # older servers may not use callback - ignore
        print("JOIN emitted (no callback).", flush=True)

@sio.event
def disconnect():
    print("🔌 Disconnected from signaling server", flush=True)

# ----- Audio capture callback -----
def audio_callback(indata, frames, time_info, status):
    global is_muted
    if status:
        print("⚠️ sounddevice status:", status, flush=True)
    if is_muted:
        return
    # convert to int16 if needed
    if indata.dtype != np.int16:
        if np.issubdtype(indata.dtype, np.floating):
            arr = np.clip(indata, -1.0, 1.0)
            int16 = (arr * 32767).astype(np.int16)
        else:
            int16 = indata.astype(np.int16)
    else:
        int16 = indata
    raw_bytes = int16.tobytes()
    b64 = base64.b64encode(raw_bytes).decode('ascii')
    try:
        send_q.put_nowait(b64)
    except queue.Full:
        # drop if busy
        pass

# ----- Network sender thread -----
def network_sender_loop():
    print("🔁 Network sender thread started", flush=True)
    while running:
        try:
            b64 = send_q.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            sio.emit("audio-chunk", {"room": ROOM_CODE, "data": b64, "sample_rate": SAMPLE_RATE, "channels": CHANNELS})
        except Exception as e:
            print("⚠️ emit failed:", e, flush=True)
            time.sleep(0.1)

# ----- Command listener thread -----
def command_listener():
    global is_muted, running
    print("🛈 Commands: mute, unmute, exit", flush=True)
    for line in sys.stdin:
        cmd = line.strip().lower()
        if cmd == "mute":
            is_muted = True
            print("🔇 Microphone muted.", flush=True)
        elif cmd == "unmute":
            is_muted = False
            print("🎤 Microphone unmuted.", flush=True)
        elif cmd == "exit":
            running = False
            print("🛑 Exiting...", flush=True)
            break

# ----- Main -----
def main():
    global running
    print(f"🎤 Starting mic stream to {SERVER_URL} room={ROOM_CODE} (sr={SAMPLE_RATE}, bs={BLOCKSIZE})", flush=True)
    try:
        sio.connect(SERVER_URL, transports=["websocket"])
    except Exception as e:
        print("❌ Socket.IO connect failed:", e, flush=True)
        # continue anyway; network sender will try to emit (will raise until connected)

    t_net = threading.Thread(target=network_sender_loop, daemon=True)
    t_net.start()

    t_cmd = threading.Thread(target=command_listener, daemon=True)
    t_cmd.start()

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE,
                            blocksize=BLOCKSIZE,
                            dtype=DTYPE,
                            channels=CHANNELS,
                            callback=audio_callback):
            print("🎧 Input stream open. Press Ctrl+C or type 'exit' to stop.", flush=True)
            while running:
                time.sleep(0.2)
    except KeyboardInterrupt:
        print("Interrupted by user", flush=True)
    except Exception as e:
        print("❌ Microphone stream error:", e, flush=True)
    finally:
        running = False
        try:
            sio.disconnect()
        except Exception:
            pass
        print("🔚 Exited mic streamer", flush=True)

if __name__ == "__main__":
    main()
