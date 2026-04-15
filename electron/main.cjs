const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');

let mainWindow = null;
let serverStarted = false;

const PORT = 7680;

// --- Auto-update state (shared with the server via global) ---
// Native folder dialog
global.termatesDialog = {
  async browseFolder() {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win || mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  },
};

global.termatesUpdate = {
  status: 'idle',       // idle | checking | available | downloading | downloaded | error
  currentVersion: null,
  latestVersion: null,
  releaseNotes: null,
  progress: null,
  error: null,
};

function setupAutoUpdater() {
  // Only works in packaged app, not in dev
  if (!app.isPackaged) {
    global.termatesUpdate.currentVersion = require('../package.json').version;
    // In dev mode, check GitHub releases directly via fetch
    checkGitHubRelease();
    return;
  }

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    global.termatesUpdate.currentVersion = app.getVersion();

    autoUpdater.on('checking-for-update', () => {
      global.termatesUpdate.status = 'checking';
    });

    autoUpdater.on('update-available', (info) => {
      global.termatesUpdate.status = 'available';
      global.termatesUpdate.latestVersion = info.version;
      global.termatesUpdate.releaseNotes = info.releaseNotes || null;
    });

    autoUpdater.on('update-not-available', () => {
      global.termatesUpdate.status = 'idle';
    });

    autoUpdater.on('download-progress', (progress) => {
      global.termatesUpdate.status = 'downloading';
      global.termatesUpdate.progress = Math.round(progress.percent);
    });

    autoUpdater.on('update-downloaded', () => {
      global.termatesUpdate.status = 'downloaded';
      global.termatesUpdate.progress = 100;
    });

    autoUpdater.on('error', (err) => {
      // electron-updater failed — fall back to GitHub API check
      console.log('Auto-updater error, falling back to GitHub API:', err.message);
      checkGitHubRelease();
    });

    // Check now, then every 30 minutes
    autoUpdater.checkForUpdates().catch(() => checkGitHubRelease());
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => checkGitHubRelease());
    }, 30 * 60 * 1000);

    // Expose download/install triggers via global
    global.termatesUpdate.download = () => autoUpdater.downloadUpdate();
    global.termatesUpdate.install = () => autoUpdater.quitAndInstall();
  } catch (err) {
    console.error('Auto-updater setup failed:', err.message);
    global.termatesUpdate.currentVersion = app.isPackaged ? app.getVersion() : require('../package.json').version;
    checkGitHubRelease();
  }
}

// Also always run GitHub check after a delay as a safety net
setTimeout(() => checkGitHubRelease(), 5000);

function isNewer(latest, current) {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Fallback: check GitHub releases API directly (works in dev mode)
async function checkGitHubRelease() {
  try {
    const res = await fetch('https://api.github.com/repos/shaurya5/termates/releases/latest', {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Termates' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.tag_name?.replace(/^v/, '');
    const current = global.termatesUpdate.currentVersion || require('../package.json').version;
    global.termatesUpdate.currentVersion = current;
    if (latest && current && isNewer(latest, current)) {
      global.termatesUpdate.status = 'available';
      global.termatesUpdate.latestVersion = latest;
      global.termatesUpdate.releaseNotes = data.body || null;
      global.termatesUpdate.releaseUrl = data.html_url;
    }
  } catch (e) { /* silent */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Termates',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  process.env.PORT = String(PORT);

  try {
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    const serverUrl = require('url').pathToFileURL(serverPath).href;
    await import(serverUrl);
  } catch (err) {
    console.error('Failed to start server:', err);
    app.quit();
  }
}

app.whenReady().then(async () => {
  await startServer();
  setupAutoUpdater();
  setTimeout(createWindow, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {});
