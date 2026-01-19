// electron/main.js
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

function createWindow() {
    const iconPath = path.join(__dirname, "..", "build", "icon.png");

  const win = new BrowserWindow({
    width: 560,
    height: 860,
    backgroundColor: "#111111",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dev: if ELECTRON_START_URL is set, load that (e.g. http://localhost:8000)
  // Prod: load the built web app from dist/
  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    win.loadURL(startUrl);
    // Uncomment for debugging:
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Open external links in default browser (e.g., release link)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Also handle same-window navigations to external sites (safety net)
  win.webContents.on("will-navigate", (event, url) => {
    const isHttp = /^https?:\/\//i.test(url);
    const startOrigin = startUrl ? new URL(startUrl).origin : null;
    const isSameDevOrigin = startOrigin && url.startsWith(startOrigin);

    if (isHttp && !isSameDevOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}


app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
