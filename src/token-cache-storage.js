"use strict";

// IndexedDB belongs to this device's application origin. Count snapshots never
// enter the synchronized vault or the plugin's credential-bearing settings.
let databasePromise;

function f_openTokenCache() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("atpath-token-cache", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("vaults");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function f_loadTokenCache(vaultIdentity) {
  if (!vaultIdentity) throw new Error("A vault identity is required for the token cache");
  const database = await f_openTokenCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("vaults", "readonly");
    const request = transaction.objectStore("vaults").get(vaultIdentity);
    transaction.oncomplete = () => resolve(request.result ?? null);
    transaction.onabort = () => reject(transaction.error || new Error("Token cache read aborted"));
    transaction.onerror = () => reject(transaction.error);
  });
}

async function f_saveTokenCache(vaultIdentity, payload) {
  if (!vaultIdentity) throw new Error("A vault identity is required for the token cache");
  const database = await f_openTokenCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("vaults", "readwrite");
    transaction.objectStore("vaults").put(payload, vaultIdentity);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Token cache write aborted"));
    transaction.onerror = () => reject(transaction.error);
  });
}

module.exports = { f_loadTokenCache, f_saveTokenCache };
