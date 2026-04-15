const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let serverStarted = false;

// The server port
const PORT = 7680;

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

  // Load the app from the local server
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open external links in system browser
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

  // Set port before importing server
  process.env.PORT = String(PORT);

  // Import the ESM server module using file:// URL
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

  // Give server a moment to bind
  setTimeout(createWindow, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep running in the dock
  if (process.platform !== 'darwin') app.quit();
});

// Don't quit when window closes on macOS - terminal sessions persist
app.on('before-quit', () => {
  // Server cleanup happens via its own signal handlers
});
