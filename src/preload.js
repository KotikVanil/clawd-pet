const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('ready'),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openChat: (desktopId) => ipcRenderer.send('open-chat', desktopId || ''),
  onPerms: (cb) => ipcRenderer.on('perms', (_e, list) => cb(list)),
  answerPerm: (id, choice) => ipcRenderer.send('perm-answer', id, choice),
});
