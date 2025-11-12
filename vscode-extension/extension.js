const vscode = require('vscode');

// <- Set this to your deployed app or http://localhost:3000 for local testing
const REMOTE_URL_BASE = 'http://localhost:3000';

function activate(context) {
  console.log('[mini-meet] activate() called'); // shows in Extension Development Host console
  try {
    const disposable = vscode.commands.registerCommand('miniMeet.open', async () => {
      console.log('[mini-meet] command miniMeet.open invoked');
      try {
        const input = await vscode.window.showInputBox({
          placeHolder: 'Enter room id (leave empty to create a random one)',
          prompt: 'Room ID for Mini Meet'
        });

        const roomId = (input && input.trim()) ? input.trim() : Math.random().toString(36).slice(2,9);
        const remoteUrl = `${REMOTE_URL_BASE}/?room=${encodeURIComponent(roomId)}`;

        const panel = vscode.window.createWebviewPanel(
          'miniMeet',
          `Mini Meet — ${roomId}`,
          vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = getWebviewContent(remoteUrl, roomId);

        panel.webview.onDidReceiveMessage(msg => {
          if (msg?.cmd === 'openExternal') {
            vscode.env.openExternal(vscode.Uri.parse(remoteUrl));
          } else if (msg?.cmd === 'copied') {
            vscode.window.showInformationMessage('Meeting link copied to clipboard');
          } else if (msg?.cmd === 'log') {
            console.log('[webview]', msg.text);
          }
        });

        vscode.window.showInformationMessage(`Mini Meet opened: ${remoteUrl}`);
      } catch (err) {
        console.error('[mini-meet] inner command error', err);
        vscode.window.showErrorMessage('Failed to open Mini Meet: ' + String(err));
      }
    });

    context.subscriptions.push(disposable);
    console.log('[mini-meet] command registered');
  } catch (e) {
    console.error('[mini-meet] activate error', e);
  }
}

function deactivate() {
  console.log('[mini-meet] deactivate() called');
}

function getWebviewContent(remoteUrl, roomId) {
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https: http:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https: http:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mini Meet — ${roomId}</title>
    <style>
      html,body{width:100%;height:100%;margin:0;background:#0b1220;font-family:sans-serif}
      .toolbar{position:absolute;top:8px;right:12px;z-index:1000;display:flex;gap:8px}
      button{background:#1f6feb;color:white;border:0;padding:8px 10px;border-radius:6px;cursor:pointer}
      iframe{width:100%;height:100%;border:0}
      .note{position:absolute;left:12px;top:10px;color:#cbd5e1;font-size:12px;z-index:1000}
    </style>
  </head>
  <body>
    <div class="note">Mini Meet — room: ${roomId}</div>
    <div class="toolbar">
      <button onclick="copyLink()">Copy Link</button>
      <button onclick="openExt()">Open Externally</button>
    </div>
    <iframe id="meetFrame" src="${remoteUrl}" allow="camera; microphone; fullscreen; autoplay"></iframe>
    <script>
      const vscode = acquireVsCodeApi();
      function copyLink(){
        const text = "${remoteUrl}";
        navigator.clipboard.writeText(text).then(()=>{
          vscode.postMessage({ cmd: 'copied' });
          try{ alert('Link copied to clipboard'); }catch(e){}
        }).catch(e=>{
          try{ alert('Could not copy link: '+e); }catch(e){}
        });
      }
      function openExt(){ vscode.postMessage({ cmd: 'openExternal' }); }
      (function forwardLogs(){
        const origLog = console.log;
        console.log = function(){ try{ vscode.postMessage({ cmd: 'log', text: Array.from(arguments).join(' ') }); }catch(e){}; origLog.apply(console, arguments); };
      })();
    </script>
  </body>
  </html>`;
}

module.exports = { activate, deactivate };
