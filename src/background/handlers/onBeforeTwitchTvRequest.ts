import pageScriptURL from "url:../../page/page.ts";
import workerScriptURL from "url:../../page/worker.ts";
import { WebRequest } from "webextension-polyfill";
import filterResponseDataWrapper from "../../common/ts/filterResponseDataWrapper";
import getHostFromUrl from "../../common/ts/getHostFromUrl";
import isChromium from "../../common/ts/isChromium";
import { twitchTvHostRegex } from "../../common/ts/regexes";

export default function onBeforeTwitchTvRequest(
  details: WebRequest.OnBeforeRequestDetailsType
): void | WebRequest.BlockingResponseOrPromise {
  const host = getHostFromUrl(details.url);
  if (!host || !twitchTvHostRegex.test(host)) return;

  filterResponseDataWrapper(details, text => {
    const parser = new DOMParser();
    const document = parser.parseFromString(text, "text/html");
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
    (document.head || document.documentElement).prepend(script);
    return (
      (document.compatMode === "BackCompat" ? "" : "<!DOCTYPE html>") +
      document.documentElement.outerHTML
    );
  });
}
