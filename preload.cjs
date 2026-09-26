const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // HUD → Main
  hudCapture:      (mode)       => ipcRenderer.send('hud-capture', mode),
  hudHistory:      ()           => ipcRenderer.send('hud-history'),
  saveRecording:      (buf, ext) => ipcRenderer.invoke('save-recording', buf, ext),
  onRecordingRegion:  (cb)  => ipcRenderer.on('recording-region', (_e, data) => cb(data)),
  onRecordingStart:   (cb)  => ipcRenderer.on('recording-start',  (_e, data) => cb(data)),
  recordingStopped:   ()    => ipcRenderer.send('recording-stopped'),
  micAccess:          ()    => ipcRenderer.invoke('mic-access'),
  openMicSettings:    ()    => ipcRenderer.send('open-mic-settings'),
  scrollCaptureDone:  (dataURL) => ipcRenderer.send('scroll-capture-done', dataURL),

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
  galleryList:       (include)  => ipcRenderer.invoke('gallery-list', include),
  galleryLoad:       (filePath) => ipcRenderer.invoke('gallery-load', filePath),
  galleryDelete:     (filePath) => ipcRenderer.invoke('gallery-delete', filePath),
  galleryRename:     (data)     => ipcRenderer.invoke('gallery-rename', data),
  galleryReveal:     (filePath) => ipcRenderer.send('gallery-reveal', filePath),
  galleryOpenFolder: ()         => ipcRenderer.send('gallery-open-folder'),

  // Media editing
  mediaRead:         (filePath) => ipcRenderer.invoke('media-read', filePath),
  saveMediaEdit:     (data)     => ipcRenderer.invoke('save-media-edit', data),
  saveFrameCapture:  (dataURL)  => ipcRenderer.send('save-frame-capture', dataURL),
  videoSessionLoad:  (filePath) => ipcRenderer.invoke('video-session-load', filePath),
  videoSessionSave:  (data)     => ipcRenderer.invoke('video-session-save', data),
  mediaList:         ()         => ipcRenderer.invoke('media-list'),
  mediaThumb:        (filePath) => ipcRenderer.invoke('media-thumb', filePath),

  // Project folders
  projectFolders:      ()     => ipcRenderer.invoke('project-folders'),
  projectFolderLink:   (id)   => ipcRenderer.invoke('project-folder-link', id),
  projectFolderUnlink: (id)   => ipcRenderer.invoke('project-folder-unlink', id),
  projectFolderReveal: (id)   => ipcRenderer.send('project-folder-reveal', id),
  projectFolderList:   (id)   => ipcRenderer.invoke('project-folder-list', id),
  projectFolderExport: (data) => ipcRenderer.invoke('project-folder-export', data),
  projectFolderImport: (data) => ipcRenderer.invoke('project-folder-import', data),
  onProjectFolderChanged: (cb) => ipcRenderer.on('project-folder-changed', (_e, id) => cb(id)),
  startDrag:          (filePath)  => ipcRenderer.send('ondragstart', filePath),
  startDragComposite: (data)      => ipcRenderer.send('ondragstart-composite', data),
  startDragAnnotated: (filePath)  => ipcRenderer.send('ondragstart-annotated', filePath),
});
