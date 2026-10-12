import { registerSW } from 'virtual:pwa-register';

let registrationRef = null;
let reloading = false;
let updateTimer = null;

export function enablePwaAutoUpdate() {
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateSW(true);
    },
    onRegisteredSW(_swUrl, registration) {
      registrationRef = registration || null;
      registrationRef?.update().catch(() => {});
      if (!updateTimer) {
        updateTimer = window.setInterval(() => {
          registrationRef?.update().catch(() => {});
        }, 10 * 60 * 1000);
      }
    },
    onRegisterError() {
      // The app remains usable even if service-worker registration fails.
    },
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  const refreshWhenVisible = () => {
    if (document.visibilityState === 'visible') {
      registrationRef?.update().catch(() => {});
    }
  };

  document.addEventListener('visibilitychange', refreshWhenVisible);
  window.addEventListener('online', refreshWhenVisible);
}
