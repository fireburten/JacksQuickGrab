const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // HUD → Main
  hudCapture:      (mode)       => ipcRenderer.send('hud-capture', mode),
  hudHistory:      ()           => ipcRenderer.send('hud-history'),
  saveRecording:      (buf, ext) => ipcRenderer.invoke('save-recording', buf, ext),
  onRecordingRegion:  (cb)  => ipcRenderer.on('recording-region', (_e, data) => cb(data)),
  onRecordingStart:   (cb)  => ipcRenderer.on('recording-start',  (_e, data) => cb(data)),
  recordingStopped:   ()    => ipcRenderer.send('recording-stopped'),

  // Capture overlay → Main
  captureDone: (data) => ipcRenderer.send('capture-done', data),
  captureCancel: () => ipcRenderer.send('capture-cancel'),
  captureReady: () => ipcRenderer.send('capture-ready'),

  // Main → Capture overlay
  onScreenImage: (cb) => ipcRenderer.on('screen-image', (_e, data) => cb(data)),

  // Main → Editor
  onImageData: (cb) => ipcRenderer.on('image-data', (_e, data) => cb(data)),

  // Window picker
  onWindowSources: (cb) => ipcRenderer.on('window-sources', (_e, data) => cb(data)),
  windowPick:      (id) => ipcRenderer.send('window-pick', id),
  windowCancel:    ()   => ipcRenderer.send('window-cancel'),

  // Editor → Main
  editorCopy:      (dataURL)  => ipcRenderer.send('editor-copy', dataURL),
  editorSave:      (data)     => ipcRenderer.invoke('editor-save', data),
  overwriteImage:  (data)     => ipcRenderer.invoke('image-overwrite', data),
  shareImage:      (data)     => ipcRenderer.invoke('share-image', data),
  ocrImage:        (data)     => ipcRenderer.invoke('ocr-image', data),
  ocrTableImage:   (data)     => ipcRenderer.invoke('ocr-table-image', data),
  editorClose:     ()         => ipcRenderer.send('editor-close'),
  annotationSave:  (data)     => ipcRenderer.send('annotation-save', data),
  annotationSaveNow: (data)   => ipcRenderer.invoke('annotation-save-now', data),
  loadImageFile:   (filePath) => ipcRenderer.invoke('image-load-file', filePath),
  clipboardImage:  ()         => ipcRenderer.invoke('clipboard-image'),
  getPathForFile:  (file)     => webUtils.getPathForFile(file),
  appInfo:         ()         => ipcRenderer.invoke('app-info'),
  permissionStatus: ()        => ipcRenderer.invoke('permission-status'),
  openScreenSettings: ()      => ipcRenderer.send('open-screen-settings'),
  hudSetCollapsed: (collapsed) => ipcRenderer.send('hud-set-collapsed', collapsed),
  shortcutsGet:    ()         => ipcRenderer.invoke('shortcuts-get'),
  shortcutsSet:    (data)     => ipcRenderer.invoke('shortcuts-set', data),

  // Gallery
  galleryList:       ()         => ipcRenderer.invoke('gallery-list'),
  galleryLoad:       (filePath) => ipcRenderer.invoke('gallery-load', filePath),
  galleryDelete:     (filePath) => ipcRenderer.invoke('gallery-delete', filePath),
  galleryRename:     (data)     => ipcRenderer.invoke('gallery-rename', data),
  galleryReveal:     (filePath) => ipcRenderer.send('gallery-reveal', filePath),
  galleryOpenFolder: ()         => ipcRenderer.send('gallery-open-folder'),
  startDrag:          (filePath)  => ipcRenderer.send('ondragstart', filePath),
  startDragComposite: (data)      => ipcRenderer.send('ondragstart-composite', data),
  startDragAnnotated: (filePath)  => ipcRenderer.send('ondragstart-annotated', filePath),
});
