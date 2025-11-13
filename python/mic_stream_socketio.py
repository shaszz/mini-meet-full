#!/usr/bin/env python3
"""
mic_stream_socketio.py

Bidirectional audio streamer using python-socketio and sounddevice.

Usage examples (Windows CMD):
  python python\mic_stream_socketio.py --server http://localhost:3000 --room test

Or with environment variables (POSIX):
  SERVER_URL=http://localhost:3000 ROOM_CODE=test python python/mic_stream_socketio.py

Dependencies:
  pip install sounddevice numpy "python-socketio[client]"

Notes:
  - This script sends local mic audio as base64 int16 PCM chunks to the server
    and plays incoming audio-chunk messages from the server through speakers.
  - Make sure server (Node) is running and relays 'audio-chunk' events in the room.
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

# ------------------ CLI / config ------------------
parser = argparse.ArgumentParser(description="Mic streamer (send+receive) via socket.io")
parser.add_argument("--server", "-s", help="Signaling server URL (default: env SERVER_URL or http://localhost:3000)")
parser.add_argument("--room",   "-r", help="Room code (default: env ROOM_CODE or test-room)")
parser.add_argument("--name",   "-n", help="Client name (default: env NAME or Python-Mic)")
parser.add_argument("--sample-rate", type=int, default=None, help="Sample rate (default: env SAMPLE_RATE or 16000)")
parser.add_argument("--channels",    type=int, default=None, help="Channels (default: env CHANNELS or 1)")
parser.add_argument("--blocksize",   type=int, default=None, help="Blocksize frames (default: env BLOCKSIZE or 1024)")
args = parser.parse_args()

SERVER_URL = args.server or os.getenv("SERVER_URL", "http://localhost:3000")
ROOM_CODE  = args.room   or os.getenv("ROOM_CODE", "test-room")
NAME       = args.name   or os.getenv("NAME", "Python-Mic")
SAMPLE_RATE = args.sample_rate or int(os.getenv("SAMPLE_RATE", "16000"))
CHANNELS    = args.channels or int(os.getenv("CHANNELS", "1"))
BLOCKSIZE   = args.blocksize or int(os.getenv("BLOCKSIZE", "1024"))
DTYPE = 'int16'

print(f"Config -> SERVER_URL={SERVER_URL}, ROOM={ROOM_CODE}, NAME={NAME}, SR={SAMPLE_RATE}, CH={CHANNELS}, BS={BLOCKSIZE}", flush=True)

# ------------------ socket.io client ------------------
sio = socketio.Client()  # do not pass reconnect/reconnect_attempts options here

is_muted = False
running = True

send_q = queue.Queue(maxsize=128)
play_q = queue.Queue(maxsize=256)

@sio.event
def connect():
    print("🔗 Connected to signaling server", flush=True)
    try:
        sio.emit("join-room", {"room": ROOM_CODE, "name": NAME}, callback=lambda res: print("JOIN:", res, flush=True))
    except Exception as e:
        print("JOIN emit error:", e, flush=True)

@sio.event
def disconnect():
    print("🔌 Disconnected from server", flush=True)

@sio.on('audio-chunk')
def on_audio_chunk(payload):
    try:
        sender = payload.get('sender') if isinstance(payload, dict) else None
        size = len(payload.get('data')) if isinstance(payload, dict) and payload.get('data') else 0
        print(f"[py recv] audio-chunk from sender={sender} bytes={size}", flush=True)
        data_b64 = payload.get('data') if isinstance(payload, dict) else payload
        if not data_b64:
            return
        raw = base64.b64decode(data_b64)
        arr = np.frombuffer(raw, dtype=np.int16)
        try:
            play_q.put_nowait(arr)
        except queue.Full:
            print("[py recv] play_q FULL, dropping", flush=True)
    except Exception as e:
        print("on_audio_chunk error:", e, flush=True)


# ------------------ audio capture callback ------------------
def audio_capture_callback(indata, frames, time_info, status):
    if status:
        print("⚠️ sounddevice status:", status, flush=True)
    if is_muted:
        return
    try:
        if indata.dtype != np.int16:
            if np.issubdtype(indata.dtype, np.floating):
                arr = np.clip(indata, -1.0, 1.0)
                int16 = (arr * 32767).astype(np.int16)
            else:
                int16 = indata.astype(np.int16)
        else:
            int16 = indata
        raw = int16.tobytes()
        b64 = base64.b64encode(raw).decode('ascii')
        try:
            send_q.put_nowait(b64)
        except queue.Full:
            # drop to avoid blocking audio thread
            pass
    except Exception as e:
        print("capture callback error:", e, flush=True)

# ------------------ network sender thread ------------------
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
            print("emit failed:", e, flush=True)
            time.sleep(0.1)

# ------------------ audio playback loop ------------------
def audio_playback_loop():
    """
    Uses blocking OutputStream callback that pulls ints from play_q and writes them.
    If not enough data, pads with zeros.
    """
    def callback(outdata, frames, time_info, status):
        try:
            required = frames * CHANNELS
            out_buf = np.zeros(required, dtype=np.int16)
            got = 0
            while got < required:
                try:
                    chunk = play_q.get_nowait()
                except queue.Empty:
                    break
                to_copy = min(len(chunk), required - got)
                out_buf[got:got+to_copy] = chunk[:to_copy]
                got += to_copy
                if to_copy < len(chunk):
                    rem = chunk[to_copy:]
                    try:
                        play_q.put_nowait(rem)
                    except queue.Full:
                        pass
            # reshape for channels
            outdata[:] = out_buf.reshape((frames, CHANNELS))
        except Exception as e:
            print("playback callback error:", e, flush=True)
            outdata.fill(0)

    try:
        with sd.OutputStream(samplerate=SAMPLE_RATE, blocksize=BLOCKSIZE, dtype='int16', channels=CHANNELS, callback=callback):
            while running:
                time.sleep(0.2)
    except Exception as e:
        print("Playback stream error:", e, flush=True)

# ------------------ command listener ------------------
def command_listener():
    global is_muted, running
    print("🛈 Commands: mute, unmute, exit", flush=True)
    for line in sys.stdin:
        cmd = line.strip().lower()
        if cmd == "mute":
            is_muted = True
            print("🔇 Muted", flush=True)
        elif cmd == "unmute":
            is_muted = False
            print("🎤 Unmuted", flush=True)
        elif cmd == "exit":
            running = False
            print("🛑 Exiting", flush=True)
            break

# ------------------ main ------------------
def main():
    global running
    print("Starting mic streamer (send+receive)...", flush=True)
    try:
        sio.connect(SERVER_URL, transports=["websocket"])
    except Exception as e:
        print("Socket connect failed (continuing):", e, flush=True)

    t_net = threading.Thread(target=network_sender_loop, daemon=True)
    t_net.start()
    t_cmd = threading.Thread(target=command_listener, daemon=True)
    t_cmd.start()
    t_play = threading.Thread(target=audio_playback_loop, daemon=True)
    t_play.start()

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, blocksize=BLOCKSIZE, dtype=DTYPE, channels=CHANNELS, callback=audio_capture_callback):
            print("Input stream open. Type 'exit' to quit.", flush=True)
            while running:
                time.sleep(0.2)
    except KeyboardInterrupt:
        print("Interrupted by user", flush=True)
    except Exception as e:
        print("Input stream error:", e, flush=True)
    finally:
        running = False
        try:
            sio.disconnect()
        except Exception:
            pass
        print("Stopped", flush=True)

if __name__ == "__main__":
    main()
