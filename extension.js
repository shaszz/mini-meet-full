
const vscode = require('vscode');
let io;
try { io = require('socket.io-client'); } catch (e) {
  
  io = null;
}

let socket = null;
let isSharing = false;
let statusItem = null;
let currentLiveRoom = null;


function activate(context) {
  
  const statusBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBtn.text = '$(broadcast) Mini Meet';
  statusBtn.tooltip = 'Open Mini Meet Web UI';
  statusBtn.command = 'miniMeet.openWebUi';
  statusBtn.show();
  context.subscriptions.push(statusBtn);

  
  const openCmd = vscode.commands.registerCommand('miniMeet.openWebUi', () => {
    openWebview(context);
  });
  context.subscriptions.push(openCmd);

  
  const toggleLiveCmd = vscode.commands.registerCommand('miniMeet.toggleLiveShare', async () => {
    if (!isSharing) await startSharing(context);
    else stopSharing(context);
  });
  context.subscriptions.push(toggleLiveCmd);

  
  const joinLiveCmd = vscode.commands.registerCommand('miniMeet.joinLive', async () => {
    const cfg = getConfig();
    const room = await vscode.window.showInputBox({ prompt: 'Enter live room to join', value: cfg.defaultLiveRoom || 'live' });
    if (room) joinLiveRoom(context, room);
  });
  context.subscriptions.push(joinLiveCmd);

  
  try {
    const last = context.globalState.get('miniMeet.lastRoom');
    if (last) statusBtn.text = `$(broadcast) Mini Meet: ${last}`;
  } catch (e) { /* ignore */ }
}


function getConfig() {
  const cfg = vscode.workspace.getConfiguration('miniMeet');
  return {
    base: (cfg.get('remoteUrl') || '').trim(),
    autoCopy: cfg.get('autoCopy') === undefined ? true : !!cfg.get('autoCopy'),
    defaultLiveRoom: (cfg.get('liveRoom') || 'live').trim()
  };
}


function openWebview(context) {
  const panel = vscode.window.createWebviewPanel(
    'miniMeetWebUi',
    'Mini Meet — Web UI',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const cfg = getConfig();
  panel.webview.html = getWebviewHtml(panel.webview, cfg.base, cfg.defaultLiveRoom);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.cmd === 'openExternal') {
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.cmd === 'copy') {
        await vscode.env.clipboard.writeText(msg.url);
        vscode.window.showInformationMessage('Link copied');
      } else if (msg.cmd === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'miniMeet.remoteUrl');
      } else if (msg.cmd === 'useConfigBase') {
        const latest = getConfig().base;
        panel.webview.postMessage({ cmd: 'configBase', base: latest });
      } else if (msg.cmd === 'startShare') {
        await startSharing(context, msg.room || getConfig().defaultLiveRoom);
      } else if (msg.cmd === 'stopShare') {
        stopSharing(context);
      } else if (msg.cmd === 'joinLive') {
        joinLiveRoom(context, msg.room || getConfig().defaultLiveRoom);
      } else if (msg.cmd === 'openRoom') {
        // ============================================================
        // FIX: Use Query Parameter (?room=ID) instead of Path (/ID)
        // This ensures the server serves index.html without 404 errors
        // ============================================================
        const base = getConfig().base || "https://gmeetclone-dtov.onrender.com";
        // Removes trailing slash if present
        const cleanBase = base.replace(/\/$/, ""); 
        const url = `${cleanBase}/?room=${msg.room}`; 
        
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } catch (err) {
      console.error('Webview message error', err);
      vscode.window.showErrorMessage('Error: ' + String(err));
    }
  }, null, context.subscriptions);

  panel.webview.postMessage({ cmd: 'configBase', base: cfg.base });
}



function ensureSocketAvailable() {
  if (!io) {
    throw new Error('Missing dependency "socket.io-client". Run `npm install socket.io-client` inside the extension folder.');
  }
}

function ensureSocketConnected(baseUrl) {
  ensureSocketAvailable();
  if (!baseUrl) throw new Error('miniMeet.remoteUrl not configured in settings (miniMeet.remoteUrl).');
  
  if (socket && socket.connected && socket.io && socket.io.uri === baseUrl) return socket;

  
  if (socket) {
    try { socket.disconnect(); } catch (e) {  }
    socket = null;
  }

  
  socket = io(baseUrl, { transports: ['websocket'], reconnectionAttempts: 5 });

  socket.on('connect', () => console.log('[miniMeet] socket connected:', socket.id));
  socket.on('disconnect', reason => console.log('[miniMeet] socket disconnected:', reason));
  socket.on('connect_error', err => console.error('[miniMeet] socket connect_error', err));

  
  socket.on('live-event', payload => {
    try { handleIncomingLiveEvent(payload); } catch (e) { console.error('live-event handler error', e); }
  });

  return socket;
}



async function startSharing(context, room) {
  if (isSharing) {
    vscode.window.showInformationMessage('Already sharing.');
    return;
  }

  try {
    ensureSocketAvailable();
  } catch (e) {
    vscode.window.showErrorMessage(String(e));
    return;
  }

  const cfg = getConfig();
  const base = cfg.base;
  if (!base) { vscode.window.showErrorMessage('Set miniMeet.remoteUrl in Settings'); return; }

  currentLiveRoom = (room || cfg.defaultLiveRoom || 'live');
  ensureSocketConnected(base);

  
  socket.emit('join-room', currentLiveRoom);

  socket.emit('live-event', { room: currentLiveRoom, type: 'start', data: {}, sender: socket.id });

  broadcastActiveEditor();

  const d1 = vscode.window.onDidChangeActiveTextEditor(() => broadcastActiveEditor());
  const d2 = vscode.window.onDidChangeTextEditorSelection(e => broadcastCursor(e));
  const d3 = vscode.workspace.onDidSaveTextDocument(doc => broadcastFileSaved(doc));
  context.subscriptions.push(d1, d2, d3);

  isSharing = true;
  updateStatusBar(true);
  vscode.window.showInformationMessage(`Started sharing live room: ${currentLiveRoom}`);
}

function stopSharing(context) {
  if (!isSharing) { vscode.window.showInformationMessage('Not sharing'); return; }
  try {
    if (socket && currentLiveRoom) {
      socket.emit('live-event', { room: currentLiveRoom, type: 'stop', data: {}, sender: socket.id });
      socket.emit('leave-room'); // optional
    }
  } catch (e) { console.warn('stopSharing emit error', e); }

  isSharing = false;
  updateStatusBar(false);
  vscode.window.showInformationMessage('Stopped sharing');
}



function joinLiveRoom(context, room) {
  try {
    ensureSocketAvailable();
  } catch (e) {
    vscode.window.showErrorMessage(String(e));
    return;
  }

  const cfg = getConfig();
  const base = cfg.base;
  if (!base) { vscode.window.showErrorMessage('Set miniMeet.remoteUrl in Settings'); return; }

  currentLiveRoom = (room || cfg.defaultLiveRoom || 'live');
  ensureSocketConnected(base);

  socket.emit('join-room', currentLiveRoom);
  vscode.window.showInformationMessage(`Joined live room: ${currentLiveRoom}. You will follow the broadcaster.`);
}


function broadcastActiveEditor() {
  if (!isSharing || !socket || !socket.connected) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const uri = doc.uri.toString();
  const sendContent = doc.isUntitled; 
  const content = sendContent ? doc.getText() : undefined;
  socket.emit('live-event', {
    room: currentLiveRoom,
    type: 'open-file',
    data: { uri, language: doc.languageId, content },
    sender: socket.id
  });
}

function broadcastCursor(e) {
  if (!isSharing || !socket || !socket.connected) return;
  if (!e || !e.textEditor || !e.selections || e.selections.length === 0) return;
  const sel = e.selections[0];
  const start = { line: sel.start.line, character: sel.start.character };
  const end = { line: sel.end.line, character: sel.end.character };
  socket.emit('live-event', {
    room: currentLiveRoom,
    type: 'cursor',
    data: { uri: e.textEditor.document.uri.toString(), start, end },
    sender: socket.id
  });
}

function broadcastFileSaved(doc) {
  if (!isSharing || !socket || !socket.connected) return;
  socket.emit('live-event', {
    room: currentLiveRoom,
    type: 'file-saved',
    data: { uri: doc.uri.toString() },
    sender: socket.id
  });
}



async function handleIncomingLiveEvent(payload) {
  if (!payload || !payload.type) return;
  const type = payload.type;
  const data = payload.data || {};

  if (type === 'open-file') {
    const uriStr = data.uri;
    const content = data.content;
    try {
      let doc;
      try {
        const uri = vscode.Uri.parse(uriStr);
        doc = await vscode.workspace.openTextDocument(uri);
      } catch (err) {
        if (content) {
          doc = await vscode.workspace.openTextDocument({ content, language: data.language || undefined });
        } else {
          return;
        }
      }
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      console.error('handleIncomingLiveEvent open-file error', err);
    }
  } else if (type === 'cursor') {
    try {
      const uri = vscode.Uri.parse(data.uri);
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
      if (editor) {
        const start = data.start || { line: 0, character: 0 };
        const pos = new vscode.Position(start.line || 0, start.character || 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (e) {  }
  } else if (type === 'file-saved') {
  } else if (type === 'start') {
  } else if (type === 'stop') {
    vscode.window.showInformationMessage('Broadcaster stopped sharing');
  }
}



function updateStatusBar(sharing) {
  const items = vscode.window.visibleTextEditors; 
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  sb.text = sharing ? '$(broadcast) Mini Meet (sharing)' : '$(broadcast) Mini Meet';
  sb.tooltip = sharing ? 'Sharing — open web UI' : 'Mini Meet — open web UI';
  sb.command = 'miniMeet.openWebUi';
  sb.show();
  setTimeout(() => sb.dispose(), 3000);
}

function randRoom() {
    return Math.random().toString(36).substring(2, 9).toUpperCase();
}

function getWebviewHtml(webview) {
  const DEFAULT_WSS = "wss://webrtc-signaling-3rbz.onrender.com";
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; connect-src wss: wss: https:;`;
  const defaultRoom = randRoom();
  const nonce = getNonce();

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root{--bg:#0f1720;--card:#0b1220;--muted:#9aa4b2;--accent:#7dd3fc}
  body{font-family:Segoe UI,Arial,system-ui;background:linear-gradient(180deg,#061021 0%, #071226 100%);color:#e6eef6;margin:16px}
  h2{margin:4px 0 12px 0;font-size:16px}
  .card{background:rgba(255,255,255,0.03);padding:12px;border-radius:10px;box-shadow:0 4px 14px rgba(2,6,23,0.6);margin-bottom:10px}
  .row{display:flex;gap:8px;align-items:center}
  input[type=text]{padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;width:200px}
  button{padding:8px 10px;border-radius:8px;border:0;background:linear-gradient(90deg,#3b82f6,#8b5cf6);color:white;cursor:pointer}
  button.secondary{background:transparent;border:1px solid rgba(255,255,255,0.06)}
  #users{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .user{padding:6px 10px;border-radius:999px;color:#071226;font-weight:700}
  #log{height:120px;overflow:auto;padding:8px;border-radius:8px;background:#02060b;color:#9fb0c6;margin-top:8px;font-family:monospace;font-size:12px}
  .meta{display:flex;gap:8px;align-items:center;margin-top:8px}
  hr { border: none; height: 1px; background: rgba(255,255,255,0.04); margin: 12px 0; }
  .note{color:#9aa4b2;font-size:13px}
</style></head><body>
  <h2>Mini Meet — Meeting & Code Share</h2>

  <div class="card">
    <div class="row">
      <label style="min-width:48px">Room</label>
      <input id="roomInput" type="text" value="${defaultRoom}" />
      <button id="createBtn" class="secondary">Create</button>
      <button id="copyRoomBtn" class="secondary">Copy</button>
      <div style="flex:1"></div>
      <button id="joinBrowser">Join (open browser)</button>
      <button id="settingsBtn" class="secondary">Settings</button>
    </div>

    <div class="meta">
      <div class="note">Base URL: <span id="baseUrl">(loading)</span></div>
      <div style="flex:1"></div>
      <button id="refreshBase" class="secondary">Refresh Base</button>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <label style="min-width:48px">DC Room</label>
      <input id="dcRoom" type="text" value="${defaultRoom}" />
      <button id="regen" class="secondary">Regenerate</button>
      <button id="copyDC" class="secondary">Copy</button>
      <div style="flex:1"></div>
      <button id="host">Host (DC)</button>
      <button id="joinDC">Join (DC)</button>
      <button id="disc" disabled>Disconnect DC</button>
    </div>

    <div class="meta">
      <label style="min-width:48px">Color</label>
      <input id="color" type="color" value="#ff79c6" />
      <button id="apply" class="secondary">Apply</button>
      <div style="flex:1"></div>
      <div id="users"></div>
    </div>

    <div id="log"></div>
  </div>

<script nonce="${nonce}">
(function(){
  // FIX 1: CRITICAL - Initialize VS Code API
  const vscode = acquireVsCodeApi();

  // --- Elements ---
  const logEl = document.getElementById('log');
  const usersEl = document.getElementById('users');

  // Meeting UI elements
  const roomInput = document.getElementById('roomInput');
  const createBtn = document.getElementById('createBtn');
  const copyRoomBtn = document.getElementById('copyRoomBtn');
  const joinBrowser = document.getElementById('joinBrowser');
  const settingsBtn = document.getElementById('settingsBtn');
  const refreshBase = document.getElementById('refreshBase');
  const baseUrlSpan = document.getElementById('baseUrl');

  // DC UI elements
  const dcRoom = document.getElementById('dcRoom');
  const regenBtn = document.getElementById('regen');
  const copyDC = document.getElementById('copyDC');
  const hostBtn = document.getElementById('host');
  const joinBtn = document.getElementById('joinDC');
  const discBtn = document.getElementById('disc');
  const colorInp = document.getElementById('color');
  const applyBtn = document.getElementById('apply');

  function log(m){ logEl.textContent += m + "\\n"; logEl.scrollTop = logEl.scrollHeight; }

  // DC state
  let pc=null, dc=null, socket=null, role=null, room=null, pending=[];

  function setState(s){
    if(s==='idle'){ hostBtn.disabled=false; joinBtn.disabled=false; discBtn.disabled=true; }
    if(s==='connecting'){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
    if(s==='connected'){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
  }

  function updateUserList(users){
    usersEl.innerHTML='';
    if(!Array.isArray(users)) return;
    for(const u of users){
      const el = document.createElement('div'); el.className='user'; el.style.background = u.color || '#ddd'; el.textContent = u.name || 'User';
      usersEl.appendChild(el);
    }
  }

  function ensurePC(){
    pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }]});
    pc.onicecandidate = e => { if(e.candidate && socket && room) socket.send(JSON.stringify({ type:'candidate', room, candidate: e.candidate })); };
    pc.onconnectionstatechange = () => { log('RTC: ' + pc.connectionState); if(pc.connectionState === 'connected') setState('connected'); if(['failed','disconnected','closed'].includes(pc.connectionState)) { reset(); } };
  }

  function wire(ch){
    dc = ch;
    dc.onopen = () => {
      log('DataChannel open');
      try { vscode.postMessage({ type:'dc-open' }); } catch(e) {}
    };
    dc.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        try { vscode.postMessage(m); } catch(ex) {}
      } catch(err) { log('Malformed DC message'); }
    };
    dc.onclose = () => log('DC closed');
  }

  async function start(r){
    reset();
    role = r;
    room = (dcRoom.value||'').trim();
    if(!room){ log('Room cannot be empty'); return; }
    setState('connecting');
    ensurePC();
    if(role === 'host'){ wire(pc.createDataChannel('code')); } else { pc.ondatachannel = e => wire(e.channel); }

    socket = new WebSocket("${DEFAULT_WSS}");
    socket.onopen = async () => { log('WS connected'); socket.send(JSON.stringify({ type: (role==='host') ? 'create' : 'join', room })); };
    socket.onmessage = async ev => {
      const msg = JSON.parse(ev.data);
      if(msg.type === 'room-state'){
        log('Room members=' + msg.count);
        if(role==='host' && msg.count > 1){
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type:'offer', room, sdp: offer }));
          log('Offer sent');
        }
        return;
      }
      if(msg.type === 'peer-joined'){
        log('Peer joined');
        if(role==='host'){
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type:'offer', room, sdp: offer }));
          log('Offer sent (peer-joined)');
        }
        return;
      }
      if(msg.type === 'offer' && role==='join'){
        await pc.setRemoteDescription(msg.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.send(JSON.stringify({ type:'answer', room, sdp: ans }));
        log('Answer sent');
        for(const c of pending){ try{ await pc.addIceCandidate(c); }catch(e){} }
        pending = [];
      } else if(msg.type === 'answer' && role==='host'){
        await pc.setRemoteDescription(msg.sdp);
        log('Answer applied');
        for(const c of pending){ try{ await pc.addIceCandidate(c); }catch(e){} }
        pending = [];
      } else if(msg.type === 'candidate'){
        if(!pc.remoteDescription){ pending.push(msg.candidate); log('Buffered candidate'); } else { try { await pc.addIceCandidate(msg.candidate); } catch(e){ log('addIceCandidate err'); } }
      }
    };
    socket.onclose = () => log('WS closed');
    socket.onerror = () => log('WS error');
  }

  function reset(){
    try{ dc && dc.close(); }catch(e){} try{ pc && pc.close(); }catch(e){} try{ socket && socket.close(); }catch(e){}
    pc = dc = socket = null; pending = []; setState('idle'); log('Disconnected');
    try { vscode.postMessage({ type:'presence-leave', id: null }); } catch(e) {}
  }

  // forward extension messages over DC if open
  window.addEventListener('message', ev => {
    const m = ev.data;
    if(!m) return;
    
    // FIX 3: Handle config update in UI
    if(m.cmd === 'configBase') {
       if(baseUrlSpan) baseUrlSpan.textContent = m.base;
       return;
    }

    if(m.type === 'user-list'){ updateUserList(m.users); return; }
    if(m.forward && dc && dc.readyState === 'open'){
      try { dc.send(JSON.stringify(m)); } catch(e) {}
    }
  });

  // Meeting UI handlers (use extension to open browser & copy)
  createBtn.onclick = () => { const r = (Math.random().toString(36).slice(2,9)).toUpperCase(); roomInput.value = r; dcRoom.value = r; };
  
  // FIX 4: Fixed command payload for Copy
  copyRoomBtn.onclick = () => { vscode.postMessage({ cmd: 'copy', url: roomInput.value }); };
  
  joinBrowser.onclick = () => {
    const r = (roomInput.value||'').trim();
    if(!r){ alert('Enter a room code or click Create'); return; }
    // This now matches the handler added in openWebview
    vscode.postMessage({ cmd: 'openRoom', room: r });
  };
  
  // FIX 5: Fixed command name to match extension (settings vs openSettings)
  settingsBtn.onclick = () => vscode.postMessage({ cmd: 'settings' });
  
  refreshBase.onclick = () => vscode.postMessage({ cmd: 'useConfigBase' });

  // DC UI handlers
  regenBtn.onclick = () => { dcRoom.value = (Math.random().toString(36).substr(2,9)).toUpperCase(); };
  copyDC.onclick = () => { vscode.postMessage({ cmd: 'copy', url: dcRoom.value }); };
  applyBtn.onclick = () => { try { vscode.postMessage({ type:'profile-update', profile:{ color: colorInp.value }, forward: true }); } catch(e) {} log('Color applied'); };

  hostBtn.onclick = () => start('host');
  joinBtn.onclick = () => start('join');
  discBtn.onclick = () => reset();

  setState('idle'); log('Ready.');

  // request base on load
  vscode.postMessage({ cmd: 'useConfigBase' });
})();
</script>
</body></html>`;
}



function escapeHtml(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function getNonce(){ let t=''; const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for(let i=0;i<32;i++) t+=chars.charAt(Math.floor(Math.random()*chars.length)); return t; }

function deactivate() {
  try { if (socket) socket.disconnect(); } catch (e) {}
}

module.exports = { activate, deactivate };
