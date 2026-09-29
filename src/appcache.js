(function () {
  const appCache = window.applicationCache;
  const messages = [];
  let updatePromise = null;
  let resolveUpdate = null;
  let lastProgress = -1;

  function log(message, type = "info") {
    if (typeof window.writeLog === "function") {
      window.writeLog(message, type);
    } else {
      messages.push({ message, type });
    }
  }

  function beginUpdate() {
    if (!updatePromise) {
      updatePromise = new Promise((resolve) => {
        resolveUpdate = resolve;
      });
    }
  }

  function finishUpdate() {
    if (resolveUpdate) {
      const resolve = resolveUpdate;
      updatePromise = null;
      resolveUpdate = null;
      lastProgress = -1;
      resolve();
    }
  }

  window.appCacheMessages = messages;

  if (!document.documentElement.hasAttribute("manifest")) {
    window.waitForAppCacheUpdate = () => Promise.resolve();
    return;
  }

  if (!appCache) {
    if ("serviceWorker" in navigator) {
      log("Preparing offline cache.");
      const serviceWorkerReady = navigator.serviceWorker
        .register("./service-worker.js")
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
          log("Offline cache is ready.", "success");
        })
        .catch((error) => {
          log(
            `Offline cache setup failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        });
      window.waitForAppCacheUpdate = () => serviceWorkerReady;
    } else {
      log("Offline caching is not supported by this browser.", "error");
      window.waitForAppCacheUpdate = () => Promise.resolve();
    }
    return;
  }

  appCache.addEventListener("checking", () => {
    beginUpdate();
    log("Checking offline cache for updates.");
  });

  appCache.addEventListener("downloading", () => {
    beginUpdate();
    log("Downloading offline cache.");
  });

  appCache.addEventListener("progress", (event) => {
    const total = event.total;
    if (!total) return;
    const progress = Math.floor((event.loaded / total) * 10) * 10;
    if (progress === lastProgress) return;
    lastProgress = progress;
    log(`Offline cache download: ${progress}% complete.`);
  });

  appCache.addEventListener("cached", () => {
    log("Offline cache is ready.", "success");
    finishUpdate();
  });

  appCache.addEventListener("noupdate", () => {
    log("Offline cache is up to date.", "success");
    finishUpdate();
  });

  appCache.addEventListener("updateready", () => {
    log("Offline cache update is ready; reload later to use the updated files.", "success");
    finishUpdate();
  });

  appCache.addEventListener("obsolete", () => {
    log("Offline cache manifest is obsolete.", "error");
    finishUpdate();
  });

  appCache.addEventListener("error", () => {
    log(
      navigator.onLine
        ? "Offline cache failed to update. Check the manifest and server MIME type."
        : "Offline cache is unavailable while offline.",
      "error",
    );
    finishUpdate();
  });

  if (
    appCache.status === appCache.CHECKING ||
    appCache.status === appCache.DOWNLOADING
  ) {
    beginUpdate();
  }

  window.waitForAppCacheUpdate = () => {
    if (
      appCache.status === appCache.CHECKING ||
      appCache.status === appCache.DOWNLOADING
    ) {
      beginUpdate();
      return updatePromise;
    }

    if (appCache.status !== appCache.UNCACHED || !navigator.onLine) {
      return Promise.resolve();
    }

    beginUpdate();
    const timeout = setTimeout(() => {
      if (!resolveUpdate) return;
      log("Offline cache update timed out; continuing with available files.", "error");
      finishUpdate();
    }, 30000);
    updatePromise.then(() => clearTimeout(timeout));

    try {
      appCache.update();
    } catch (error) {
      log(
        `Unable to start offline cache update: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      finishUpdate();
    }

    return updatePromise || Promise.resolve();
  };
})();
