/* EXPLORA PWA registration · v2.3.7 */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js', {
        scope: './',
        updateViaCache: 'none'
      });
      registration.update().catch(() => {});

      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);
    } catch (error) {
      console.error('[EXPLORA_PWA_REGISTRATION_ERROR]', error);
    }
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
