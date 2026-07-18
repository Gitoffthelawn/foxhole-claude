// Viewer - reads content from storage using key in URL hash, then renders it
// Works in both Firefox (browser.*) and Chrome (chrome.*)
(function() {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const key = window.location.hash.slice(1);

  function showError(msg) {
    document.getElementById('loading').style.display = 'none';
    const errEl = document.getElementById('error');
    errEl.style.display = 'block';
    errEl.textContent = msg;
  }

  if (!key) {
    showError('No content key provided');
    return;
  }

  api.storage.local.get(key).then(result => {
    const entry = result[key];
    api.storage.local.remove(key);

    if (!entry) {
      showError('Content not found (may have already been opened)');
      return;
    }

    if (entry.type === 'markdown') {
      // Render markdown as a styled preformatted page
      document.title = entry.title || 'Claude Report';
      document.open();
      document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${entry.title || 'Claude Report'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 24px 60px; background: #1a1a1a; color: #e0e0e0; line-height: 1.7; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: 'SF Mono','Fira Code','Consolas',monospace; font-size: 14px; background: #252525; padding: 24px; border-radius: 8px; border: 1px solid #333; }
</style>
</head>
<body><pre>${entry.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body>
</html>`);
      document.close();
    } else {
      // HTML — write the full document directly
      document.open();
      document.write(entry.content);
      document.close();
    }

  }).catch(e => {
    showError('Error: ' + e.message);
  });
})();
