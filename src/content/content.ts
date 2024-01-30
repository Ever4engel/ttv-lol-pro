import pageScriptURL from "url:../page/page.ts";
import workerScriptURL from "url:../page/worker.ts";
import browser, { Storage } from "webextension-polyfill";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import isChromium from "../common/ts/isChromium";
import { getStreamStatus, setStreamStatus } from "../common/ts/streamStatus";
import store from "../store";
import { State } from "../store/types";
import { MessageType } from "../types";

console.info("[TTV LOL PRO] Content script running.");

if (isChromium) injectPageScript();
// Firefox uses FilterResponseData to inject the page script.

if (store.readyState === "complete") onStoreLoad();
else store.addEventListener("load", onStoreLoad);
store.addEventListener("change", onStoreChange);

browser.runtime.onMessage.addListener(onBackgroundMessage);
window.addEventListener("message", onPageMessage);

function injectPageScript() {
  // From https://stackoverflow.com/a/9517879
  const script = document.createElement("script");
  script.src = pageScriptURL; // src/page/page.ts
  script.dataset.params = JSON.stringify({
    isChromium,
    workerScriptURL, // src/page/worker.ts
  });
  script.onload = () => script.remove();
  // ---------------------------------------
  // 🦊 Attention Firefox Addon Reviewer 🦊
  // ---------------------------------------
  // Please note that this does NOT involve remote code execution. The injected scripts are bundled
  // with the extension. The `url:` imports above are used to get the runtime URLs of the respective scripts.
  // Additionally, there is no custom Content Security Policy (CSP) in use.
  (document.head || document.documentElement).prepend(script); // Note: Despite what the TS types say, `document.head` can be `null`.
}

function onStoreLoad() {
  // Clear stats for stream on page load/reload.
  clearStats();
}

/**
 * Clear stats for stream on page load/reload.
 * @returns
 */
function clearStats() {
  const channelName = findChannelFromTwitchTvUrl(location.href);
  if (!channelName) return;

  if (store.state.streamStatuses.hasOwnProperty(channelName)) {
    delete store.state.streamStatuses[channelName];
  }
  console.log(
    `[TTV LOL PRO] Cleared stats for channel '${channelName}' (content script).`
  );
}

function onStoreChange(changes: Record<string, Storage.StorageChange>) {
  const changedKeys = Object.keys(changes) as (keyof State)[];
  // This is mainly to reduce the amount of messages sent to the page script.
  // (Also to reduce the number of console logs.)
  const ignoredKeys: (keyof State)[] = [
    "adLog",
    "dnsResponses",
    "openedTwitchTabs",
    "streamStatuses",
    "videoWeaverUrlsByChannel",
  ];
  if (changedKeys.every(key => ignoredKeys.includes(key))) return;
  console.log("[TTV LOL PRO] Store changed:", changes);
  window.postMessage({
    type: MessageType.PageScriptMessage,
    message: {
      type: MessageType.GetStoreStateResponse,
      state: JSON.parse(JSON.stringify(store.state)),
    },
  });
}

function onBackgroundMessage(message: any) {
  switch (message.type) {
    case MessageType.EnableFullModeResponse:
      window.postMessage({
        type: MessageType.PageScriptMessage,
        message,
      });
      window.postMessage({
        type: MessageType.WorkerScriptMessage,
        message,
      });
      break;
  }
}

function onPageMessage(event: MessageEvent) {
  if (event.data?.type !== MessageType.ContentScriptMessage) return;

  const message = event.data?.message;
  if (!message) return;

  switch (message.type) {
    case MessageType.GetStoreState:
      const sendStoreState = () => {
        window.postMessage({
          type: MessageType.PageScriptMessage,
          message: {
            type: MessageType.GetStoreStateResponse,
            state: JSON.parse(JSON.stringify(store.state)),
          },
        });
      };
      if (store.readyState === "complete") sendStoreState();
      else store.addEventListener("load", sendStoreState);
      break;
    case MessageType.EnableFullMode:
      try {
        browser.runtime.sendMessage(message);
      } catch (error) {
        console.error(
          "[TTV LOL PRO] Failed to send EnableFullMode message",
          error
        );
      }
      break;
    case MessageType.DisableFullMode:
      try {
        browser.runtime.sendMessage(message);
      } catch (error) {
        console.error(
          "[TTV LOL PRO] Failed to send DisableFullMode message",
          error
        );
      }
      break;
    case MessageType.UsherResponse:
      const { channel, videoWeaverUrls, proxyCountry } = message;
      // Update Video Weaver URLs.
      store.state.videoWeaverUrlsByChannel[channel] = [
        ...(store.state.videoWeaverUrlsByChannel[channel] ?? []),
        ...videoWeaverUrls,
      ];
      // Update proxy country.
      const streamStatus = getStreamStatus(channel);
      setStreamStatus(channel, {
        ...(streamStatus ?? { proxied: false, reason: "" }),
        proxyCountry,
      });
      break;
    case MessageType.ClearStats:
      clearStats();
      break;
  }
}
