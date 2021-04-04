const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');

// Catch Fatal Exceptions
process.on('uncaughtException', (_error) => {
  app.exit(1);
});

// Usually, you only want one instance of your application running at any moment.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

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
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
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
  mainWindow.loadFile('index.html');

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();

  // Open external links in the browser
  mainWindow.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    shell.openExternal(url);
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
