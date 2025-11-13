// public/client.js (FINAL)
// Integrated WebRTC mesh + chat + audio-chunk receiver + browser mic emitter
console.log('[client] loaded');
const socket = io();
let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection
const remoteVideoContainers = {}; // socketId -> {card, video}
const videoArea = document.getElementById('videoArea');
const joinBtn = document.getElementById('joinBtn');
const roomIdInput = document.getElementById('roomIdInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const btnToggleAudio = document.getElementById('btnToggleAudio');
const btnToggleVideo = document.getElementById('btnToggleVideo');
const leaveBtn = document.getElementById('leaveBtn');
const btnShare = document.getElementById('btnShare');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatWindow = document.getElementById('chatWindow');

let roomId = null;
let localVideoElem = null;
let audioEnabled = true;
let videoEnabled = true;

const STUN_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------------- Local media ----------------
async function initLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addLocalVideo();
    return localStream;
  } catch (e) {
    alert('Could not get camera/mic: ' + (e && e.message ? e.message : e));
    throw e;
  }
}

function addLocalVideo() {
  if (localVideoElem) return;
  localVideoElem = document.createElement('video');
  localVideoElem.autoplay = true;
  localVideoElem.muted = true;
  localVideoElem.playsInline = true;
  localVideoElem.srcObject = localStream;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.appendChild(localVideoElem);
  const label = document.createElement('div');
  label.className = 'label';
  label.innerText = 'You';
  card.appendChild(label);
  videoArea.prepend(card);
}

// ---------------- Remote video helpers ----------------
function createRemoteVideo(socketId) {
  if (remoteVideoContainers[socketId]) return remoteVideoContainers[socketId].video;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.id = 'video_' + socketId;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.appendChild(video);

  const label = document.createElement('div');
  label.className = 'label';
  label.innerText = socketId;
  card.appendChild(label);

  videoArea.appendChild(card);
  remoteVideoContainers[socketId] = { card, video };
  return video;
}

function removeRemoteVideo(socketId) {
  const entry = remoteVideoContainers[socketId];
  if (entry) {
    entry.card.remove();
    delete remoteVideoContainers[socketId];
  }
}

// ---------------- PeerConnection (mesh) ----------------
function createPeerConnection(targetSocketId) {
  if (peers[targetSocketId]) return peers[targetSocketId];
  const pc = new RTCPeerConnection(STUN_SERVERS);
  console.log('[pc] create for', targetSocketId);

  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  } else {
    console.warn('createPeerConnection: localStream not ready');
  }

  pc.ontrack = (ev) => {
    const el = createRemoteVideo(targetSocketId);
    if (el.srcObject !== ev.streams[0]) el.srcObject = ev.streams[0];
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit('ice-candidate', { target: targetSocketId, candidate: ev.candidate, sender: socket.id, roomId });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[pc] state', targetSocketId, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      try { pc.close(); } catch (e) {}
      delete peers[targetSocketId];
      removeRemoteVideo(targetSocketId);
    }
  };

  peers[targetSocketId] = pc;
  return pc;
}

// ---------------- Join / UI ----------------
joinBtn.addEventListener('click', async () => {
  if (!roomIdInput.value.trim()) {
    roomId = Math.random().toString(36).slice(2, 9);
    roomIdInput.value = roomId;
  } else roomId = roomIdInput.value.trim();

  await initLocalStream();
  socket.emit('join-room', roomId);
  joinBtn.disabled = true;
  roomIdInput.disabled = true;

  // start browser mic emitter shortly after join (user gesture needed)
  setTimeout(() => {
    if (startMicEmitter) startMicEmitter(); // function defined later
  }, 200);
});

copyLinkBtn.addEventListener('click', () => {
  const url = location.origin + '/?room=' + encodeURIComponent(roomIdInput.value.trim());
  navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
});

btnToggleAudio.addEventListener('click', () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
  btnToggleAudio.innerText = audioEnabled ? 'Mute' : 'Unmute';
});

btnToggleVideo.addEventListener('click', () => {
  if (!localStream) return;
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  btnToggleVideo.innerText = videoEnabled ? 'Stop Video' : 'Start Video';
});

leaveBtn.addEventListener('click', () => {
  if (!roomId) return;
  socket.emit('leave-room');
  cleanupAll();
  joinBtn.disabled = false;
  roomIdInput.disabled = false;
});

function cleanupAll() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (localVideoElem) localVideoElem.srcObject = null;
  for (const id in peers) {
    try { peers[id].close(); } catch (e) {}
    delete peers[id];
  }
  Object.keys(remoteVideoContainers).forEach(removeRemoteVideo);
  chatWindow.innerHTML = '';
  roomId = null;
}

// ---------------- chat ----------------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !roomId) return;
  socket.emit('send-chat', text);
  appendChat({ sender: 'You', text, ts: Date.now() });
  chatInput.value = '';
});
function appendChat({ sender, text, ts }) {
  const d = new Date(ts);
  const el = document.createElement('div');
  el.className = 'chatMessage';
  el.innerHTML = `<div class="meta">${sender} • ${d.toLocaleTimeString()}</div><div>${escapeHtml(text)}</div>`;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}
function escapeHtml(s) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

// ---------------- Socket handlers / Signaling ----------------
(function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if (r) roomIdInput.value = r;
})();

socket.on('connect', () => console.log('[socket] connected', socket.id));

socket.on('existing-users', async (users) => {
  console.log('[socket] existing-users', users);
  // newcomer creates offers to each existing user
  for (const otherId of users) {
    const pc = createPeerConnection(otherId);
    createRemoteVideo(otherId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { target: otherId, sdp: offer, sender: socket.id, roomId });
    } catch (err) {
      console.error('offer error', err);
    }
  }
});

socket.on('user-joined', (socketId) => {
  console.log('[socket] user-joined', socketId);
  createRemoteVideo(socketId);
});

socket.on('offer', async (payload) => {
  console.log('[socket] offer from', payload.sender);
  const { sender, sdp } = payload;
  const pc = peers[sender] || createPeerConnection(sender);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target: sender, sdp: answer, sender: socket.id, roomId });
  } catch (err) {
    console.error('handle offer error', err);
  }
});

socket.on('answer', async (payload) => {
  console.log('[socket] answer from', payload.sender);
  const pc = peers[payload.sender];
  if (!pc) return console.warn('no pc for answer');
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } catch (err) {
    console.error('setRemoteDescription(answer) failed', err);
  }
});

socket.on('ice-candidate', async (payload) => {
  const { sender, candidate } = payload;
  const pc = peers[sender];
  if (!pc) return console.warn('no pc for candidate yet from', sender);
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('addIceCandidate failed', err);
  }
});

socket.on('chat', (msg) => appendChat({ sender: msg.sender, text: msg.text, ts: msg.ts }));

socket.on('user-left', (socketId) => {
  console.log('[socket] user-left', socketId);
  if (peers[socketId]) { try { peers[socketId].close(); } catch (e) {} delete peers[socketId]; }
  removeRemoteVideo(socketId);
});

// ---------------- Audio chunk receiver (play incoming base64 int16 PCM) ----------------
(function initRemoteAudioReceiver() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    console.warn('AudioContext not supported');
    return;
  }
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let playTime = audioCtx.currentTime;

  function int16ToFloat32(int16Array) {
    const float32 = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32[i] = int16Array[i] / 32768;
    }
    return float32;
  }

  socket.on('audio-chunk', (msg) => {
    try {
      const b64 = msg.data;
      const sampleRate = msg.sample_rate || 16000;
      const channels = msg.channels || 1;

      // decode base64 -> Uint8Array
      const raw = atob(b64);
      const rawLen = raw.length;
      const bytes = new Uint8Array(rawLen);
      for (let i = 0; i < rawLen; i++) bytes[i] = raw.charCodeAt(i);

      // int16 view (assumes little-endian)
      const int16 = new Int16Array(bytes.buffer);

      // to float32
      const float32 = int16ToFloat32(int16);

      // create AudioBuffer
      const frameCount = float32.length / channels;
      const audioBuffer = audioCtx.createBuffer(channels, frameCount, sampleRate);

      if (channels === 1) {
        audioBuffer.getChannelData(0).set(float32);
      } else {
        for (let ch = 0; ch < channels; ch++) {
          const chan = audioBuffer.getChannelData(ch);
          for (let i = 0, j = ch; i < chan.length; i++, j += channels) {
            chan[i] = float32[j];
          }
        }
      }

      // schedule playback
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (playTime < now) playTime = now + 0.02;
      source.start(playTime);
      playTime += audioBuffer.duration;
    } catch (e) {
      console.error('audio-chunk handling error', e);
    }
  });

  // resume AudioContext on user gesture
  document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  console.log('Remote audio receiver initialized');
})();

// ---------------- Browser mic emitter (capture + send base64 int16 PCM) ----------------
/*
  - Emits { room, data, sample_rate, channels } events on socket
  - Resamples (naive linear) to OUT_SAMPLE_RATE if needed
  - Starts on user gesture (click or when Join pressed)
*/
(function initBrowserMicEmitterModule() {
  const OUT_SAMPLE_RATE = 16000; // must match python
  const OUT_CHANNELS = 1;
  const OUT_BLOCK_MS = 200; // chunk size in ms (tune for latency)
  const OUT_BLOCK_FRAMES = Math.floor(OUT_SAMPLE_RATE * (OUT_BLOCK_MS / 1000));
  let micStream = null;
  let recorderNode = null;
  let audioCtx = null;
  let inputReady = false;
  let pcmBuffer = []; // array of Float32Array fragments

  async function startMicEmitter() {
    if (inputReady) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      micStream = stream;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);

      // ScriptProcessorNode (legacy) - bufferSize power of two
      const bufferSize = 4096;
      recorderNode = audioCtx.createScriptProcessor(bufferSize, OUT_CHANNELS, OUT_CHANNELS);

      recorderNode.onaudioprocess = (evt) => {
        try {
          const inBuf = evt.inputBuffer.getChannelData(0);
          // copy input float32
          pcmBuffer.push(new Float32Array(inBuf));

          // compute total samples accumulated
          let total = 0;
          for (const b of pcmBuffer) total += b.length;

          if (total >= OUT_BLOCK_FRAMES) {
            // build OUT_BLOCK_FRAMES sized Float32Array
            const out = new Float32Array(OUT_BLOCK_FRAMES);
            let offset = 0;
            while (offset < OUT_BLOCK_FRAMES && pcmBuffer.length) {
              const chunk = pcmBuffer[0];
              const need = OUT_BLOCK_FRAMES - offset;
              if (chunk.length <= need) {
                out.set(chunk, offset);
                offset += chunk.length;
                pcmBuffer.shift();
              } else {
                out.set(chunk.subarray(0, need), offset);
                pcmBuffer[0] = chunk.subarray(need);
                offset += need;
              }
            }

            // resample if needed
            let float32ForEncoding = out;
            if (audioCtx.sampleRate !== OUT_SAMPLE_RATE) {
              const r = OUT_SAMPLE_RATE / audioCtx.sampleRate;
              const newLen = Math.floor(out.length * r);
              const resampled = new Float32Array(newLen);
              for (let i = 0; i < newLen; i++) {
                const idx = i / r;
                const i0 = Math.floor(idx);
                const i1 = Math.min(out.length - 1, i0 + 1);
                const t = idx - i0;
                resampled[i] = out[i0] * (1 - t) + out[i1] * t;
              }
              float32ForEncoding = resampled;
            }

            // float32 -> int16 little-endian
            const int16 = new Int16Array(float32ForEncoding.length);
            for (let i = 0; i < float32ForEncoding.length; i++) {
              let s = Math.max(-1, Math.min(1, float32ForEncoding[i]));
              int16[i] = s < 0 ? s * 32768 : s * 32767;
            }

            // bytes view
            const bytes = new Uint8Array(int16.buffer);

            // base64 encode in chunks to avoid stack issues
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            const b64 = btoa(binary);

            // emit to server (include room)
            if (roomId) {
              // just before socket.emit in the emitter
              console.log(`[emit audio-chunk] room=${roomId} bytes=${b64.length}`);
              socket.emit('audio-chunk', { room: roomId, data: b64, sample_rate: OUT_SAMPLE_RATE, channels: OUT_CHANNELS });
            }
          }
        } catch (ex) {
          console.error('recorder error', ex);
        }
      };

      source.connect(recorderNode);
      // connect to destination but set gain to 0 so we don't hear our own chunks (avoid feedback)
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      recorderNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      inputReady = true;
      console.log('🔊 Browser mic emitter started (click page once to allow)');
    } catch (e) {
      console.error('Failed to start mic emitter', e);
    }
  }

  // start on user gesture
  document.addEventListener('click', () => {
    if (!inputReady) startMicEmitter();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  // also start when user clicks Join (helps UX)
  joinBtn.addEventListener('click', () => { setTimeout(() => { if (!inputReady) startMicEmitter(); }, 200); });

  // expose startMicEmitter for manual call
  window.startMicEmitter = startMicEmitter;
})();

// end of file
