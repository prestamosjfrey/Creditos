const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
let mainWindow = null;

// Carga las variables de entorno desde la ubicación correcta según el contexto.
// En desarrollo: usa .env del proyecto. En producción: usa extraResources/.env
// y lo copia a userData (editable por el usuario sin reinstalar).
function prepararEnv() {
  if (app.isPackaged) {
    const envOrigen = path.join(process.resourcesPath, '.env');
    const envUsuario = path.join(app.getPath('userData'), '.env');
    if (!fs.existsSync(envUsuario) && fs.existsSync(envOrigen)) {
      try { fs.copyFileSync(envOrigen, envUsuario); } catch (_) {}
    }
    const envFinal = fs.existsSync(envUsuario) ? envUsuario : envOrigen;
    require('dotenv').config({ path: envFinal });
  } else {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  }
}

function esperarServidor(cb, intentos = 0) {
  if (intentos >= 50) {
    console.error('[Cartera] El servidor no respondió después de 15 s. Cerrando.');
    app.quit();
    return;
  }
  const req = http.get(`http://localhost:${PORT}/auth/login`, (res) => {
    if (res.statusCode < 500) cb();
    else setTimeout(() => esperarServidor(cb, intentos + 1), 300);
  });
  req.on('error', () => setTimeout(() => esperarServidor(cb, intentos + 1), 300));
  req.end();
}

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Cartera',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Pantalla de carga mientras el servidor Express inicia
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  // Navegar a la app cuando el servidor esté listo
  esperarServidor(() => {
    if (mainWindow) mainWindow.loadURL(`http://localhost:${PORT}`);
  });

  // Links externos se abren en el navegador del sistema, no en Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  prepararEnv();

  // Iniciar el servidor Express en el mismo proceso de Node de Electron
  require('../server');

  crearVentana();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) crearVentana();
});
