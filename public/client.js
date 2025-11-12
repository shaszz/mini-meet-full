// public/client.js
console.log('[client] loaded');
const socket = io();
let localStream = null;
const peers = {};
const remoteVideoContainers = {};
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

// ---------------- local media ----------------
async function initLocalStream(){
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

function addLocalVideo(){
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

// ---------------- remote video helpers ----------------
function createRemoteVideo(socketId){
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

function removeRemoteVideo(socketId){
  const entry = remoteVideoContainers[socketId];
  if(entry){
    entry.card.remove();
    delete remoteVideoContainers[socketId];
  }
}

// ---------------- PeerConnection ----------------
function createPeerConnection(targetSocketId){
  const existing = peers[targetSocketId];
  if (existing) return existing;
  const pc = new RTCPeerConnection(STUN_SERVERS);

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
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed'){
      try { pc.close(); } catch(e){}
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
    roomId = Math.random().toString(36).slice(2,9);
    roomIdInput.value = roomId;
  } else roomId = roomIdInput.value.trim();

  await initLocalStream();
  socket.emit('join-room', roomId);
  joinBtn.disabled = true;
  roomIdInput.disabled = true;
});

copyLinkBtn.addEventListener('click', () => {
  const url = location.origin + '/?room=' + encodeURIComponent(roomIdInput.value.trim());
  navigator.clipboard.writeText(url).then(()=> alert('Link copied!'));
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

function cleanupAll(){
  if(localStream){
    localStream.getTracks().forEach(t=>t.stop());
    localStream = null;
  }
  if(localVideoElem) localVideoElem.srcObject = null;
  for(const id in peers) {
    try { peers[id].close(); } catch(e){}
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
function escapeHtml(s){ return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

// ---------------- Socket handlers / Signaling ----------------
(function prefillFromQuery(){
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if (r) roomIdInput.value = r;
})();

socket.on('connect', () => console.log('[socket] connected', socket.id));

socket.on('existing-users', async (users) => {
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
  const { sender, sdp } = payload;
  const pc = peers[sender] || createPeerConnection(sender);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { target: sender, sdp: answer, sender: socket.id, roomId });
});

socket.on('answer', async (payload) => {
  const { sender, sdp } = payload;
  const pc = peers[sender];
  if (!pc) { console.warn('No pc for answer from', sender); return; }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async (payload) => {
  const { sender, candidate } = payload;
  const pc = peers[sender];
  if (!pc) { console.warn('No pc for candidate yet from', sender); return; }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error('addIceCandidate failed', e); }
});

socket.on('chat', (msg) => appendChat({ sender: msg.sender, text: msg.text, ts: msg.ts }));

socket.on('user-left', (socketId) => {
  if(peers[socketId]) { try { peers[socketId].close(); } catch(e){} delete peers[socketId]; }
  removeRemoteVideo(socketId);
});

// ---------------- Audio chunk receiver ----------------
(function initRemoteAudioReceiver(){
  // requires socket (socket.io client)
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

  // resume on user gesture
  document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });
  console.log('Remote audio receiver initialized');
})();
