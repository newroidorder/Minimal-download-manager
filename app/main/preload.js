'use strict';

// The only bridge between the windows and the program. Windows run sandboxed
// with no Node access; they call mdm.invoke(name, ...args) and listen with
// mdm.on(event, fn).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdm', {
  invoke: (name, ...args) => ipcRenderer.invoke('mdm', name, ...args),
  on: (event, fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on(`mdm:${event}`, handler);
    return () => ipcRenderer.off(`mdm:${event}`, handler);
  },
  params: Object.fromEntries(new URLSearchParams(window.location.search))
});
