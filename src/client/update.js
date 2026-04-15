// ============================================
// Auto-Update
// ============================================

import { showNotif } from './notifications.js';

async function checkForUpdate() {
  try {
    const res = await fetch('/api/update/status');
    const u = await res.json();
    const banner = document.getElementById('update-banner');
    const msg = document.getElementById('update-message');
    const btn = document.getElementById('update-action');
    const ver = document.getElementById('version-info');

    if (u.currentVersion) ver.textContent = `v${u.currentVersion}`;

    if (u.status === 'available') {
      banner.classList.remove('hidden', 'downloading', 'ready');
      msg.textContent = `v${u.latestVersion} available`;
      btn.textContent = 'Update';
      btn.className = 'update-btn';
      btn.onclick = async () => {
        if (u.releaseUrl) {
          // In server-only mode, open the release page
          window.open(u.releaseUrl, '_blank');
        } else {
          // In Electron mode, trigger download
          await fetch('/api/update/download', { method: 'POST' });
          btn.textContent = 'Downloading...';
          btn.disabled = true;
        }
      };
    } else if (u.status === 'downloading') {
      banner.classList.remove('hidden', 'ready');
      banner.classList.add('downloading');
      msg.textContent = `Downloading... ${u.progress || 0}%`;
      btn.textContent = `${u.progress || 0}%`;
      btn.disabled = true;
    } else if (u.status === 'downloaded') {
      banner.classList.remove('hidden', 'downloading');
      banner.classList.add('ready');
      msg.textContent = 'Update ready';
      btn.textContent = 'Restart';
      btn.className = 'update-btn installing';
      btn.disabled = false;
      btn.onclick = () => fetch('/api/update/install', { method: 'POST' });
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) { /* silent */ }
}

export { checkForUpdate };

// Check on load and every 5 minutes
setTimeout(checkForUpdate, 3000);
setInterval(checkForUpdate, 5 * 60 * 1000);
