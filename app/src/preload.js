const { contextBridge, ipcRenderer } = require('electron');

function onEvent(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bsk', {
  isElectron: true,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    hideToTray: () => ipcRenderer.invoke('window:hideToTray'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximized: (cb) => onEvent('window:maximized', cb),
  },
  events: {
    onStateUpdate: (cb) => onEvent('state:update', cb),
    onConsoleLine: (cb) => onEvent('console:line', cb),
    onConsoleError: (cb) => onEvent('console:error', cb),
    onConsoleClear: (cb) => onEvent('console:clear', cb),
    onPackagesUpdated: (cb) => onEvent('packages:updated', cb),
  },
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
});
