// The floating thumbnail after a capture (lib/quick-access.cjs makes the window). Click the image to
// edit it, drag it into another app, or use the buttons. After a few seconds it asks main to dismiss
// it, but not while the pointer is over it. Main checks the real cursor too, since macOS doesn't
// send hover events to an inactive app's windows; while main keeps it, it asks again every second.
(function () {
  const api = window.electronAPI;
  const RETRY_MS = 1000;
  const shot = document.getElementById('shot');
  const preview = document.getElementById('preview');
  const copyButton = document.getElementById('btn-copy');
  let dismissAfterMs = 6000;
  let timer = null;
  let copiedTimer = null;

  function scheduleDismiss(ms = dismissAfterMs) {
    clearTimeout(timer);
    timer = setTimeout(function ask() {
      api?.thumbnailAction('dismiss');
      timer = setTimeout(ask, RETRY_MS);
    }, ms);
  }

  function pauseDismiss() {
    clearTimeout(timer);
    timer = null;
  }

  const act = action => () => api?.thumbnailAction(action);

  api?.onThumbnailData(data => {
    preview.src = data.preview;
    if (data.dismissAfterMs > 0) dismissAfterMs = data.dismissAfterMs;
    if (!document.documentElement.matches(':hover')) scheduleDismiss();
  });

  document.documentElement.addEventListener('mouseenter', pauseDismiss);
  document.documentElement.addEventListener('mouseleave', () => scheduleDismiss());

  shot.addEventListener('click', act('edit'));
  shot.addEventListener('dragstart', e => {
    e.preventDefault();   // main starts a native drag of the saved file instead
    api?.thumbnailDrag();
    // The pointer leaves with the drag, and no hover event may come back to say so.
    scheduleDismiss();
  });
  document.getElementById('btn-edit').addEventListener('click', act('edit'));
  document.getElementById('btn-pin').addEventListener('click', act('pin'));
  document.getElementById('btn-close').addEventListener('click', act('close'));
  copyButton.addEventListener('click', () => {
    api?.thumbnailAction('copy');
    copyButton.textContent = 'Copied';
    copyButton.classList.add('done');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copyButton.textContent = 'Copy';
      copyButton.classList.remove('done');
    }, 1500);
  });
})();
