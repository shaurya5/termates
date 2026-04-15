const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let serverStarted = false;

const PORT = 7680;

// --- Auto-update state (shared with the server via global) ---
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
      global.termatesUpdate.status = 'error';
      global.termatesUpdate.error = err.message;
    });

    // Check now, then every 30 minutes
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);

    // Expose download/install triggers via global
    global.termatesUpdate.download = () => autoUpdater.downloadUpdate();
    global.termatesUpdate.install = () => autoUpdater.quitAndInstall();
  } catch (err) {
    console.error('Auto-updater setup failed:', err.message);
    global.termatesUpdate.currentVersion = app.getVersion();
    checkGitHubRelease();
  }
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
    const current = global.termatesUpdate.currentVersion;
    if (latest && current && latest !== current) {
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
