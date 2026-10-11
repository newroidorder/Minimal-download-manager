'use strict';

// The only bridge between the windows and the program. Windows run sandboxed
// with no Node access; they call idm.invoke(name, ...args) and listen with
// idm.on(event, fn).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idm', {
  invoke: (name, ...args) => ipcRenderer.invoke('idm', name, ...args),
  on: (event, fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on(`idm:${event}`, handler);
    return () => ipcRenderer.off(`idm:${event}`, handler);
  },
  params: Object.fromEntries(new URLSearchParams(window.location.search))
});
