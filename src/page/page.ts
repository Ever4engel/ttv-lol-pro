import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import toAbsoluteUrl from "../common/ts/toAbsoluteUrl";
import { MessageType } from "../types";
import { getFetch } from "./getFetch";
import {
  getSendMessageToContentScript,
  getSendMessageToContentScriptAndWaitForResponse,
  getSendMessageToPageScript,
  getSendMessageToPageScriptAndWaitForResponse,
  getSendMessageToWorkerScript,
  getSendMessageToWorkerScriptAndWaitForResponse,
} from "./sendMessage";
import type { PageState } from "./types";

console.info("[TTV LOL PRO] Page script running.");

const params = JSON.parse(document.currentScript!.dataset.params!);

const sendMessageToContentScript = getSendMessageToContentScript();
const sendMessageToContentScriptAndWaitForResponse =
  getSendMessageToContentScriptAndWaitForResponse();
const sendMessageToPageScript = getSendMessageToPageScript();
const sendMessageToPageScriptAndWaitForResponse =
  getSendMessageToPageScriptAndWaitForResponse();
const sendMessageToWorkerScript = getSendMessageToWorkerScript();
const sendMessageToWorkerScriptAndWaitForResponse =
  getSendMessageToWorkerScriptAndWaitForResponse();

const pageState: PageState = {
  isChromium: params.isChromium,
  scope: "page",
  state: undefined,
  twitchWorker: undefined,
  sendMessageToContentScript,
  sendMessageToContentScriptAndWaitForResponse,
  sendMessageToPageScript,
  sendMessageToPageScriptAndWaitForResponse,
  sendMessageToWorkerScript,
  sendMessageToWorkerScriptAndWaitForResponse,
};

window.fetch = getFetch(pageState);

window.Worker = class Worker extends window.Worker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    const fullUrl = toAbsoluteUrl(scriptURL.toString());
    const isTwitchWorker = fullUrl.includes(".twitch.tv");
    if (!isTwitchWorker) {
      super(scriptURL, options);
      return;
    }
    let script = "";
    // Fetch Twitch's script, since Firefox Nightly errors out when trying to
    // import a blob URL directly.
    const xhr = new XMLHttpRequest();
    xhr.open("GET", fullUrl, false);
    xhr.send();
    if (200 <= xhr.status && xhr.status < 300) {
      script = xhr.responseText;
    } else {
      console.warn(`[TTV LOL PRO] Failed to fetch script: ${xhr.statusText}`);
      script = `importScripts('${fullUrl}');`; // Will fail on Firefox Nightly.
    }
    // ---------------------------------------
    // 🦊 Attention Firefox Addon Reviewer 🦊
    // ---------------------------------------
    // Please note that this does NOT involve remote code execution. The injected script is bundled
    // with the extension. Additionally, there is no custom Content Security Policy (CSP) in use.
    const newScript = `
      var getParams = () => '${JSON.stringify(params)}';
      try {
        importScripts('${params.workerScriptURL}');
      } catch (error) {
        console.error('[TTV LOL PRO] Failed to load script: ${
          params.workerScriptURL
        }:', error);
      }
      ${script}
    `;
    const newScriptURL = URL.createObjectURL(
      new Blob([newScript], { type: "text/javascript" })
    );
    // Required for VAFT compatibility.
    const wrapperScript = `
      try {
        importScripts('${newScriptURL}');
      } catch (error) {
        console.warn('[TTV LOL PRO] Failed to wrap script: ${newScriptURL}:', error);
        ${newScript}
      }
    `;
    const wrapperScriptURL = URL.createObjectURL(
      new Blob([wrapperScript], { type: "text/javascript" })
    );
    super(wrapperScriptURL, options);
    pageState.twitchWorker = this;
    this.addEventListener("message", event => {
      if (
        event.data?.type === MessageType.ContentScriptMessage ||
        event.data?.type === MessageType.PageScriptMessage
      ) {
        window.postMessage(event.data);
      }
    });
    URL.revokeObjectURL(newScriptURL);
    URL.revokeObjectURL(wrapperScriptURL);
  }
};

let sendStoreStateToWorker = false;
window.addEventListener("message", event => {
  // Relay messages from the content script to the worker script.
  if (event.data?.type === MessageType.WorkerScriptMessage) {
    sendMessageToWorkerScript(pageState.twitchWorker, event.data.message);
    return;
  }

  if (event.data?.type !== MessageType.PageScriptMessage) return;

  const message = event.data?.message;
  if (!message) return;

  switch (message.type) {
    case MessageType.GetStoreState: // From Worker
      if (pageState.state != null) {
        sendMessageToWorkerScript(pageState.twitchWorker, {
          type: MessageType.GetStoreStateResponse,
          state: pageState.state,
        });
      }
      sendStoreStateToWorker = true;
      break;
    case MessageType.GetStoreStateResponse: // From Content
      if (pageState.state == null) {
        console.log("[TTV LOL PRO] Received store state from content script.");
      } else {
        console.debug(
          "[TTV LOL PRO] Received store state from content script."
        );
      }
      const state = message.state;
      pageState.state = state;
      if (sendStoreStateToWorker) {
        sendMessageToWorkerScript(pageState.twitchWorker, {
          type: MessageType.GetStoreStateResponse,
          state,
        });
      }
      break;
  }
});

function onChannelChange(
  callback: (channelName: string, oldChannelName: string | null) => void
) {
  let channelName: string | null = findChannelFromTwitchTvUrl(location.href);

  const NATIVE_PUSH_STATE = window.history.pushState;
  function pushState(
    data: any,
    unused: string,
    url?: string | URL | null | undefined
  ) {
    if (!url) return NATIVE_PUSH_STATE.call(window.history, data, unused);
    const fullUrl = toAbsoluteUrl(url.toString());
    const newChannelName = findChannelFromTwitchTvUrl(fullUrl);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
    return NATIVE_PUSH_STATE.call(window.history, data, unused, url);
  }
  window.history.pushState = pushState;

  const NATIVE_REPLACE_STATE = window.history.replaceState;
  function replaceState(
    data: any,
    unused: string,
    url?: string | URL | null | undefined
  ) {
    if (!url) return NATIVE_REPLACE_STATE.call(window.history, data, unused);
    const fullUrl = toAbsoluteUrl(url.toString());
    const newChannelName = findChannelFromTwitchTvUrl(fullUrl);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
    return NATIVE_REPLACE_STATE.call(window.history, data, unused, url);
  }
  window.history.replaceState = replaceState;

  window.addEventListener("popstate", () => {
    const newChannelName = findChannelFromTwitchTvUrl(location.href);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
  });
}

onChannelChange((_channelName, oldChannelName) => {
  sendMessageToContentScript({
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
  sendMessageToPageScript({
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
  sendMessageToWorkerScript(pageState.twitchWorker, {
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
});

sendMessageToContentScript({ type: MessageType.GetStoreState });

document.currentScript!.remove();
