const { contextBridge, shell } = require('electron');

contextBridge.exposeInMainWorld('cardStudio', {
  isElectron: true,
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  },
});
