const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');

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
    width: 620,
    height: 540,
    title: 'Super Pads',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FFF',
    // transparent: true,
    frame: process.platform === 'darwin',
    resizable: false,
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
