/**
 * Card Studio · Electron 主进程
 *
 * 职责：
 *   1. 决定用户数据目录（~/Library/Application Support/Card Studio/）
 *   2. 首次启动把打包进来的种子数据拷到用户数据目录
 *   3. 找空闲端口，fork server.js（打包后要指向 app.asar.unpacked）
 *   4. 等 server 起来后打开窗口，before-quit 清理子进程
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { fork } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;

// ============================================================
// 路径工具
// ============================================================
function getUserDataDir() {
  // 打包：~/Library/Application Support/Card Studio/
  // 开发：card-studio/
  if (app.isPackaged) return app.getPath('userData');
  return path.join(__dirname, '..');
}

function getDataDir() {
  return path.join(getUserDataDir(), 'data');
}

function getConfigFile() {
  return path.join(getUserDataDir(), 'config.json');
}

// 打包后 server.js 在 app.asar.unpacked
function getServerPath() {
  const base = path.join(__dirname, '..', 'server.js');
  if (app.isPackaged) return base.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  return base;
}

// 种子数据：打包时走 extraResources，放在 Resources/seed-data
function getSeedDataDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'seed-data');
  return path.join(__dirname, '..', 'data');
}

// ============================================================
// 首次启动：拷种子数据
// ============================================================
function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function ensureDataDir() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  // 只有 userData 完全没有 books.json 时才拷种子（避免覆盖用户数据）
  const booksJson = path.join(dataDir, 'books.json');
  if (!fs.existsSync(booksJson)) {
    const seed = getSeedDataDir();
    if (fs.existsSync(seed) && seed !== dataDir) {
      console.log(`[seed] 首次启动，拷贝种子数据 ${seed} → ${dataDir}`);
      copyRecursive(seed, dataDir);
    }
  }
  console.log(`[data] ${dataDir}`);
}

// ============================================================
// 空闲端口
// ============================================================
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ============================================================
// 启动后端
// ============================================================
function startServer() {
  return new Promise(async (resolve, reject) => {
    try {
      serverPort = await findFreePort();
    } catch (err) {
      return reject(err);
    }

    const env = {
      ...process.env,
      PORT: String(serverPort),
      CARD_DATA_DIR: getDataDir(),
      CARD_CONFIG_FILE: getConfigFile(),
      NO_AUTO_OPEN: '1',
    };

    const serverPath = getServerPath();
    console.log(`[server] fork ${serverPath} on :${serverPort}`);

    serverProcess = fork(serverPath, [], { env, silent: true });

    let resolved = false;
    const done = () => {
      if (!resolved) { resolved = true; resolve(); }
    };

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[server]', msg.trim());
      if (msg.includes('卡片书斋 running')) done();
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[server:err]', data.toString().trim());
    });

    serverProcess.on('error', (err) => {
      console.error('[server] 启动失败：', err);
      done();
    });

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[server] 退出 code=${code}`);
      }
    });

    // 兜底：5 秒内没看到 running 也继续
    setTimeout(done, 5000);
  });
}

// ============================================================
// 窗口
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Card Studio',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes(`localhost:${serverPort}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key === 'r') {
      mainWindow.reload();
      event.preventDefault();
    }
    if ((input.meta || input.control) && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
// 生命周期
// ============================================================
app.on('ready', async () => {
  ensureDataDir();
  await startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    serverProcess = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    serverProcess = null;
  }
});
