const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 960,
    minHeight: 540,
    title: 'NovaFlix',
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setUserAgent(mainWindow.webContents.getUserAgent() + ' NovaFlixApp Electron');

  // Carrega a interface do cliente localmente
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  mainWindow.loadFile(indexPath);

  // Redireciona links externos para o navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
