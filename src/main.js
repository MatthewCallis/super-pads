const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const runWorker = require('./runWorker');
const { atomicWrite } = require('./fileStorage');

/** Return a user-selected MIDI/native pattern path; cancellation is an ordinary empty result. */
ipcMain.handle('pickPatternFile', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Import MIDI or SX Pattern', properties: ['openFile', 'dontAddToRecent'],
    filters: [{ name: 'MIDI and SX patterns', extensions: ['mid', 'midi', 'bin'] }],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

/** Export only to the path selected in the save dialog; flush complete bytes before replacement. */
ipcMain.handle('exportPatternFile', async (event, { bytes, filename, midi }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: midi ? 'Export MIDI' : 'Export SX Pattern', defaultPath: path.basename(filename),
    filters: [{ name: midi ? 'MIDI' : 'SX pattern', extensions: [midi ? 'mid' : 'bin'] }],
  });
  if (result.canceled || !result.filePath) return false;
  atomicWrite(result.filePath, Buffer.from(bytes));
  return true;
});

/** Own ESM-dependent jobs in Node threads; reply only after their worker has produced a terminal result. */
ipcMain.handle('runDataWorker', async (_event, { name, data }) => {
  try {
    if (!['parsePads', 'encodePads', 'writeCard', 'convertPattern', 'encodeFile'].includes(name)) throw new Error('Unsupported data operation.');
    return await runWorker(name, data);
  } catch (error) {
    // Electron's rejected IPC promises discard custom error fields, including the recovery lockout flag.
    return { success: false, error: error.message, recoveryRequired: Boolean(error.recoveryRequired) };
  }
});

// Catch Fatal Exceptions
process.on('uncaughtException', (_error) => {
  app.exit(1);
});

// Usually, you only want one instance of your application running at any moment.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

/** Create the local editor window and route web links to the default browser. */
function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    // Five banks per row expose all 120 pads; smaller windows keep the matrix scrollable.
    width: 1480,
    height: 760,
    minWidth: 1100,
    minHeight: 600,
    title: 'Super Pads',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FFF',
    // transparent: true,
    frame: process.platform === 'darwin',
    resizable: true,
    webPreferences: {
      // The local renderer and its audio/file workers still use CommonJS and Node APIs.
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInWorker: true,
      devTools: false,
    },
  });

  // Disable Refresh
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([]));
  } else {
    mainWindow.removeMenu();
  }

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();

  // Electron 22 removed new-window. Deny child windows so they cannot inherit Node access.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (['https:', 'http:'].includes(new URL(url).protocol)) {
      shell.openExternal(url).catch(console.error);
    }
    return { action: 'deny' };
  });

  return mainWindow;
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.on('pickSDCard', (event) => {
  dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Select SD Card',
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
  }).then(({ filePaths }) => {
    let valid = true;
    // Doesn't seem like a Roland
    const [root] = filePaths;
    if (!fs.readdirSync(root).includes('ROLAND')) {
      valid = false;
    }
    event.sender.send('pickSDCard-task-finished', { root, valid });
  }).catch((error) => {
    event.sender.send('pickSDCard-task-finished', { root: '', valid: false, error });
  });
});

ipcMain.on('pickFile', (event) => {
  dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Select File to Convert',
    properties: ['openFile', 'createDirectory', 'dontAddToRecent'],
  }).then(({ filePaths }) => {
    const [file] = filePaths;
    event.sender.send('pickFile-task-finished', { file });
  }).catch((error) => {
    event.sender.send('pickFile-task-finished', { error });
  });
});
