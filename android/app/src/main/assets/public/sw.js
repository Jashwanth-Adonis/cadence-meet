/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-afac4cd2'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "pwa-maskable-512x512.png",
    "revision": "0c165e1d74845c968eb30dc23280cadd"
  }, {
    "url": "pwa-512x512.png",
    "revision": "f2cbb7fc905b489e95997e85baa708f7"
  }, {
    "url": "pwa-192x192.png",
    "revision": "53f65f16db9091ba6d69c5ef479b96e9"
  }, {
    "url": "index.html",
    "revision": "9ef5e6fd8aeafcb83811623651d24ce7"
  }, {
    "url": "icon.svg",
    "revision": "baaaf25781e86438f2eaec6b4d65e5a4"
  }, {
    "url": "icon-maskable.svg",
    "revision": "90be9ac4de27b6b9b84366dcb79d2f26"
  }, {
    "url": "favicon.ico",
    "revision": "6ae8ba48121bb47b2e9be0dda791379a"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "52012254787ab6a706e43eb33f9c8539"
  }, {
    "url": "assets/workbox-window.prod.es5-Bd17z0YL.js",
    "revision": null
  }, {
    "url": "assets/index-D3heMAZ_.js",
    "revision": null
  }, {
    "url": "assets/index--65_iW-n.css",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "52012254787ab6a706e43eb33f9c8539"
  }, {
    "url": "favicon.ico",
    "revision": "6ae8ba48121bb47b2e9be0dda791379a"
  }, {
    "url": "icon.svg",
    "revision": "baaaf25781e86438f2eaec6b4d65e5a4"
  }, {
    "url": "pwa-192x192.png",
    "revision": "53f65f16db9091ba6d69c5ef479b96e9"
  }, {
    "url": "pwa-512x512.png",
    "revision": "f2cbb7fc905b489e95997e85baa708f7"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "0c165e1d74845c968eb30dc23280cadd"
  }, {
    "url": "manifest.webmanifest",
    "revision": "62ba6022def35f957f97eaf6b84d36de"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("index.html")));
  workbox.registerRoute(/^https:\/\/fonts\.googleapis\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.gstatic\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "gstatic-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
