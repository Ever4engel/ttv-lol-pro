import * as m3u8Parser from "m3u8-parser";
import acceptFlag from "../common/ts/acceptFlag";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import findChannelFromUsherUrl from "../common/ts/findChannelFromUsherUrl";
import generateRandomString from "../common/ts/generateRandomString";
import getHostFromUrl from "../common/ts/getHostFromUrl";
import {
  twitchGqlHostRegex,
  usherHostRegex,
  videoWeaverHostRegex,
} from "../common/ts/regexes";
import { MessageType } from "../types";
import type { FetchOptions, PlaybackAccessToken, VideoWeaver } from "./types";

const NATIVE_FETCH = self.fetch;
const IS_CHROMIUM = !!self.chrome;

// FIXME: Use rolling codes to secure the communication between the content, page, and worker scripts.
// TODO: A lot of proxied requests are GQL requests with Client-Integrity header. Can we do something about that?
//            The playback access token request doesn't require it if always using _Template!
// TODO: Fix Chromium support. Also why anonymous mode limited to Firefox currently??

export function getFetch(options: FetchOptions): typeof fetch {
  let videoWeavers: VideoWeaver[] = [];
  let proxiedVideoWeaverUrls = new Set<string>(); // Used to proxy only the first request to each Video Weaver URL.
  let cachedPlaybackTokenRequestHeaders: Map<string, string> | null = null; // Cached by page script.
  let cachedPlaybackTokenRequestBody: string | null = null; // Cached by page script.
  let cachedUsherRequestUrl: string | null = null; // Cached by worker script.

  if (options.shouldWaitForStore) {
    setTimeout(() => {
      options.shouldWaitForStore = false;
    }, 5000);
  }

  if (options.scope === "page") {
    self.addEventListener("message", async event => {
      if (event.data?.type !== MessageType.PageScriptMessage) return;

      const message = event.data?.message;
      if (!message) return;

      switch (message.type) {
        case MessageType.NewPlaybackAccessToken:
          const newPlaybackAccessToken =
            await fetchReplacementPlaybackAccessToken(
              cachedPlaybackTokenRequestHeaders,
              cachedPlaybackTokenRequestBody
            );
          const message = {
            type: MessageType.NewPlaybackAccessTokenResponse,
            newPlaybackAccessToken,
          };
          console.log("[TTV LOL PRO] 💬 Sent message to workers", message);
          options.twitchWorker?.postMessage({
            type: MessageType.WorkerScriptMessage,
            message,
          });
          break;
      }
    });
  }

  self.addEventListener("message", event => {
    if (
      event.data?.type !== MessageType.PageScriptMessage &&
      event.data?.type !== MessageType.WorkerScriptMessage
    )
      return;

    const message = event.data?.message;
    if (!message) return;

    switch (message.type) {
      case MessageType.ClearStats:
        console.info("[TTV LOL PRO] 📊 Fetch stats cleared.");
        videoWeavers = [];
        cachedPlaybackTokenRequestHeaders = null;
        cachedPlaybackTokenRequestBody = null;
        cachedUsherRequestUrl = null;
        break;
    }
  });

  // // TEST CODE
  // if (options.scope === "worker") {
  //   setTimeout(
  //     () =>
  //       updateVideoWeaverReplacementMap(
  //         cachedUsherRequestUrl,
  //         videoWeavers[videoWeavers.length - 1]
  //       ),
  //     15000
  //   );
  // }

  async function waitForStore() {
    while (options.shouldWaitForStore) await sleep(100);
  }

  return async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : input.toString();
    // Firefox doesn't support relative URLs in content scripts (workers too!).
    // See https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#content_script_https_requests
    if (url.startsWith("//")) {
      // Missing protocol.
      const newUrl = `${location.protocol}${url}`;
      if (input instanceof Request) input = new Request(newUrl, input);
      else input = newUrl;
    } else if (url.startsWith("/")) {
      // Missing origin.
      const newUrl = `${location.origin}${url}`;
      if (input instanceof Request) input = new Request(newUrl, input);
      else input = newUrl;
    }
    const host = getHostFromUrl(url);
    const headersMap = getHeadersMap(input, init);

    let request: Request | null = null;

    // Reading the request body can be expensive, so we only do it if we need to.
    let requestBody: string | null | undefined = undefined;
    const readRequestBody = async (): Promise<string | null> => {
      if (requestBody !== undefined) return requestBody;
      return getRequestBodyText(input, init);
    };

    //#region Requests

    // Twitch GraphQL requests.
    graphql: if (host != null && twitchGqlHostRegex.test(host)) {
      //#region GraphQL integrity requests.
      const integrityHeader = getHeaderFromMap(headersMap, "Client-Integrity");
      const isIntegrityRequest = url === "https://gql.twitch.tv/integrity";
      const isIntegrityHeaderRequest = integrityHeader != null;
      if (isIntegrityRequest || isIntegrityHeaderRequest) {
        await waitForStore();
        const shouldFlagRequest =
          (options.state?.optimizedProxiesEnabled === true &&
            options.state?.passportLevel === 2) ||
          (options.state?.optimizedProxiesEnabled === false &&
            options.state?.passportLevel === 1); // Level 2 proxies all GQL requests.
        if (shouldFlagRequest) {
          if (isIntegrityRequest) {
            console.debug("[TTV LOL PRO] Flagging GraphQL integrity request…");
            flagRequest(headersMap);
          } else if (isIntegrityHeaderRequest) {
            console.debug(
              "[TTV LOL PRO] Flagging GraphQL request with Client-Integrity header…"
            );
            flagRequest(headersMap);
          }
        }
        break graphql;
      }
      //#endregion

      //#region GraphQL PlaybackAccessToken requests.
      requestBody ??= await readRequestBody();
      if (requestBody != null && requestBody.includes("PlaybackAccessToken")) {
        // Cache the request headers and body for later use.
        const headersMapCopy = new Map(headersMap);
        flagRequest(headersMapCopy); // Make sure the cached request is flagged.
        cachedPlaybackTokenRequestHeaders = headersMapCopy;
        cachedPlaybackTokenRequestBody = requestBody;

        // Check if this is a livestream and if it's whitelisted.
        await waitForStore();
        let graphQlBody = null;
        try {
          graphQlBody = JSON.parse(requestBody);
        } catch (error) {
          console.error(
            "[TTV LOL PRO] Failed to parse GraphQL request body:",
            error
          );
        }
        const channelName = graphQlBody?.variables?.login as string | undefined;
        const isLivestream = graphQlBody?.variables?.isLive as
          | boolean
          | undefined;
        const whitelistedChannelsLower = options.state?.whitelistedChannels.map(
          channel => channel.toLowerCase()
        );
        const isWhitelisted =
          channelName != null &&
          whitelistedChannelsLower != null &&
          whitelistedChannelsLower.includes(channelName.toLowerCase());

        // Check if we should flag this request.
        const shouldFlagRequest =
          options.state?.passportLevel === 1 ||
          options.state?.passportLevel === 2;
        if (!shouldFlagRequest) break graphql;
        if (!isLivestream || isWhitelisted) {
          console.log(
            "[TTV LOL PRO] Not flagging PlaybackAccessToken request: not a livestream or is whitelisted."
          );
          break graphql;
        }

        const isTemplateRequest = requestBody.includes(
          "PlaybackAccessToken_Template"
        );
        const areIntegrityRequestsProxied =
          (options.state?.optimizedProxiesEnabled === true &&
            options.state?.passportLevel === 2) ||
          (options.state?.optimizedProxiesEnabled === false &&
            options.state?.passportLevel === 1);
        // "PlaybackAccessToken" requests contain a Client-Integrity header.
        // Thus, if integrity requests are not proxied, we can't proxy this request.
        const willFailIntegrityCheckIfProxied =
          !isTemplateRequest && !areIntegrityRequestsProxied;
        const shouldOverrideRequest =
          options.state?.anonymousMode === true ||
          willFailIntegrityCheckIfProxied;

        if (shouldOverrideRequest) {
          const newRequest = getFallbackPlaybackAccessTokenRequest(
            channelName,
            options.state?.anonymousMode === true
          );
          if (newRequest) {
            console.log(
              "[TTV LOL PRO] Overriding PlaybackAccessToken request…"
            );
            request = newRequest; // This request is already flagged.
            // Since this is a template request, whether or not integrity requests are proxied doesn't matter.
          } else {
            console.error(
              "[TTV LOL PRO] Failed to override PlaybackAccessToken request."
            );
          }
        }
        // Notice that if anonymous mode fails, we still flag the request to avoid ads.
        if (!willFailIntegrityCheckIfProxied) {
          console.debug("[TTV LOL PRO] Flagging PlaybackAccessToken request…");
          flagRequest(headersMap);
        }
        break graphql;
      }
      //#endregion
    }

    // Usher requests.
    if (host != null && usherHostRegex.test(host)) {
      cachedUsherRequestUrl = url; // Cache the URL for later use.
      console.debug("[TTV LOL PRO] Detected Usher request.");
    }

    // Video Weaver requests.
    if (host != null && videoWeaverHostRegex.test(host)) {
      const videoWeaver = videoWeavers.find(videoWeaver =>
        [...videoWeaver.assignedMap.values()].includes(url)
      );
      if (videoWeaver == null) {
        console.warn(
          "[TTV LOL PRO] 🥅 Caught Video Weaver request, but no associated Video Weaver found."
        );
      }
      let videoWeaverUrl = url;

      if (videoWeaver?.replacementMap != null) {
        const video = [...videoWeaver.assignedMap].find(
          ([, url]) => url === videoWeaverUrl
        )?.[0];
        // Replace Video Weaver URL with replacement URL.
        if (video != null && videoWeaver.replacementMap.has(video)) {
          videoWeaverUrl = videoWeaver.replacementMap.get(video)!;
          console.debug(
            `[TTV LOL PRO] 🔄 Replaced Video Weaver URL '${url}' with '${videoWeaverUrl}'.`
          );
        } else if (videoWeaver.replacementMap.size > 0) {
          videoWeaverUrl = [...videoWeaver.replacementMap.values()][0];
          console.warn(
            `[TTV LOL PRO] 🔄 Replaced Video Weaver URL '${url}' with '${videoWeaverUrl}' (fallback).`
          );
        } else {
          console.error(
            `[TTV LOL PRO] 🔄 No replacement Video Weaver URL found for '${url}'.`
          );
        }
      }

      // Flag first request to each Video Weaver URL.
      if (!proxiedVideoWeaverUrls.has(videoWeaverUrl)) {
        proxiedVideoWeaverUrls.add(videoWeaverUrl);
        console.log(
          `[TTV LOL PRO] 🥅 Caught first request to Video Weaver URL. Flagging…`
        );
        flagRequest(headersMap);
      }

      request ??= new Request(videoWeaverUrl, {
        ...init,
        headers: Object.fromEntries(headersMap),
      });
    }

    //#endregion

    request ??= new Request(input, {
      ...init,
      headers: Object.fromEntries(headersMap),
    });
    const response = await NATIVE_FETCH(request);

    // Reading the response body can be expensive, so we only do it if we need to.
    let responseBody: string | undefined = undefined;
    const readResponseBody = async (): Promise<string> => {
      if (responseBody !== undefined) return responseBody;
      const clonedResponse = response.clone();
      return clonedResponse.text();
    };

    //#region Responses

    // Usher responses.
    if (host != null && usherHostRegex.test(host)) {
      responseBody ??= await readResponseBody();
      console.log("[TTV LOL PRO] 🥅 Caught Usher response.");
      const videoWeaverMap = parseUsherManifest(responseBody);
      if (videoWeaverMap != null) {
        videoWeavers.push({
          assignedMap: videoWeaverMap,
          replacementMap: null,
          consecutiveMidrollResponses: 0,
        });
      }
      const videoWeaverUrls = [...(videoWeaverMap?.values() ?? [])];
      // Send Video Weaver URLs to content script.
      sendMessageToContentScript({
        type: MessageType.UsherResponse,
        channel: findChannelFromUsherUrl(url),
        videoWeaverUrls,
        proxyCountry:
          /USER-COUNTRY="([A-Z]+)"/i.exec(responseBody)?.[1] || undefined,
      });
      // Remove all Video Weaver URLs from known URLs.
      videoWeaverUrls.forEach(url => proxiedVideoWeaverUrls.delete(url));
    }

    // Video Weaver responses.
    if (host != null && videoWeaverHostRegex.test(host)) {
      responseBody ??= await readResponseBody();
      const videoWeaver = videoWeavers.find(videoWeaver =>
        [...videoWeaver.assignedMap.values()].includes(url)
      );
      if (videoWeaver == null) {
        console.warn(
          "[TTV LOL PRO] 🥅 Caught Video Weaver response, but no associated Video Weaver found."
        );
        return response;
      }

      // Check if response contains midroll ad.
      if (
        responseBody.includes("stitched-ad") &&
        responseBody.toLowerCase().includes("midroll")
      ) {
        console.log(
          "[TTV LOL PRO] 🥅 Caught Video Weaver response containing ad."
        );
        videoWeaver.consecutiveMidrollResponses += 1;
        // Avoid infinite loops.
        if (videoWeaver.consecutiveMidrollResponses <= 2) {
          const success = await updateVideoWeaverReplacementMap(
            cachedUsherRequestUrl,
            videoWeaver
          );
          if (success) {
            cancelRequest();
          } else {
            videoWeaver.replacementMap = null;
          }
        } else {
          videoWeaver.replacementMap = null;
        }
      } else {
        // No ad, clear attempts.
        videoWeaver.consecutiveMidrollResponses = 0;
      }
    }

    //#endregion

    return response;
  };
}

/**
 * Converts a HeadersInit to a map.
 * @param headers
 * @returns
 */
function getHeadersMap(
  input: RequestInfo | URL,
  init?: RequestInit
): Map<string, string> {
  const headers = input instanceof Request ? input.headers : init?.headers;
  if (!headers) return new Map();
  if (headers instanceof Headers) {
    return new Map(headers.entries());
  }
  if (Array.isArray(headers)) {
    return new Map(headers);
  }
  return new Map(Object.entries(headers));
}

/**
 * Converts a BodyInit to a string.
 * @param body
 * @returns
 */
async function getRequestBodyText(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | null> {
  if (input instanceof Request) {
    const clonedRequest = input.clone();
    return clonedRequest.text();
  }
  const body = init?.body;
  if (body == null) return null;
  if (body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof FormData) {
    const entries = [...body.entries()];
    return entries.map(e => `${e[0]}=${e[1]}`).join("&");
  }
  return body.toString();
}

function findHeaderFromMap(
  headersMap: Map<string, string>,
  name: string
): string | undefined {
  return [...headersMap.keys()].find(
    header => header.toLowerCase() === name.toLowerCase()
  );
}

function getHeaderFromMap(
  headersMap: Map<string, string>,
  name: string
): string | null {
  const header = findHeaderFromMap(headersMap, name);
  return header != null ? headersMap.get(header)! : null;
}

function setHeaderToMap(
  headersMap: Map<string, string>,
  name: string,
  value: string
) {
  const header = findHeaderFromMap(headersMap, name);
  headersMap.set(header ?? name, value);
}

function removeHeaderFromMap(headersMap: Map<string, string>, name: string) {
  const header = findHeaderFromMap(headersMap, name);
  if (header != null) {
    headersMap.delete(header);
  }
}

function flagRequest(headersMap: Map<string, string>) {
  if (IS_CHROMIUM) {
    console.debug(
      "[TTV LOL PRO] 🚩 Request flagging is not supported on Chromium. Ignoring…"
    );
    return;
  }
  const accept = getHeaderFromMap(headersMap, "Accept");
  if (accept != null && accept.includes(acceptFlag)) return;
  setHeaderToMap(headersMap, "Accept", `${accept || ""}${acceptFlag}`);
}

function cancelRequest(): never {
  throw new Error();
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//#region Messages

/**
 * Sends a message to the content script.
 * @param message
 */
function sendMessageToContentScript(message: any) {
  self.postMessage({
    type: MessageType.ContentScriptMessage,
    message,
  });
}

/**
 * Sends a message to the content script and waits for a response.
 * @param scope
 * @param message
 */
async function sendMessageToContentScriptAndWaitForResponse(
  scope: "page" | "worker",
  message: any,
  messageResponseType: MessageType,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (
        (scope === "page" &&
          event.data?.type !== MessageType.PageScriptMessage) ||
        (scope === "worker" &&
          event.data?.type !== MessageType.WorkerScriptMessage)
      )
        return;

      const message = event.data?.message;
      if (!message) return;

      if (message.type === messageResponseType) {
        resolve(message);
      }
    };
    self.addEventListener("message", listener);
    sendMessageToContentScript(message);
    setTimeout(() => {
      self.removeEventListener("message", listener);
      reject(new Error("Timed out waiting for message response."));
    }, timeoutMs);
  });
}

/**
 * Sends a message to the page script.
 * @param message
 */
function sendMessageToPageScript(message: any) {
  self.postMessage({
    type: MessageType.PageScriptMessage,
    message,
  });
}

/**
 * Sends a message to the page script and waits for a response.
 * @param scope
 * @param message
 */
async function sendMessageToPageScriptAndWaitForResponse(
  scope: "page" | "worker",
  message: any,
  messageResponseType: MessageType,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (
        (scope === "page" &&
          event.data?.type !== MessageType.PageScriptMessage) ||
        (scope === "worker" &&
          event.data?.type !== MessageType.WorkerScriptMessage)
      )
        return;

      const message = event.data?.message;
      if (!message) return;

      if (message.type === messageResponseType) {
        resolve(message);
      }
    };
    self.addEventListener("message", listener);
    sendMessageToPageScript(message);
    setTimeout(() => {
      self.removeEventListener("message", listener);
      reject(new Error("Timed out waiting for message response."));
    }, timeoutMs);
  });
}

//#endregion

//#region Video Weaver URL replacement

/**
 * Returns a PlaybackAccessToken request that can be used when Twitch doesn't send one.
 * @param channel
 * @returns
 */
function getFallbackPlaybackAccessTokenRequest(
  channel: string | null = null,
  anonymousMode: boolean = false
): Request | null {
  // We can use `location.href` because we're in the page script.
  const channelName = channel ?? findChannelFromTwitchTvUrl(location.href);
  if (!channelName) return null;
  const isVod = /^\d+$/.test(channelName); // VODs have numeric IDs.

  const cookieMap = new Map<string, string>(
    document.cookie
      .split(";")
      .map(cookie => cookie.trim().split("="))
      .map(([name, value]) => [name, decodeURIComponent(value)])
  );

  const headersMap = new Map<string, string>([
    [
      "Authorization",
      cookieMap.has("auth-token") && !anonymousMode
        ? `OAuth ${cookieMap.get("auth-token")}`
        : "undefined",
    ],
    ["Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko"],
    ["Device-ID", generateRandomString(32)],
  ]);
  flagRequest(headersMap);

  return new Request("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: Object.fromEntries(headersMap),
    body: JSON.stringify({
      operationName: "PlaybackAccessToken_Template",
      query:
        'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}',
      variables: {
        isLive: !isVod,
        login: isVod ? "" : channelName,
        isVod: isVod,
        vodID: isVod ? channelName : "",
        playerType: "site",
      },
    }),
  });
}

/**
 * Fetches a new PlaybackAccessToken from Twitch.
 * @param cachedPlaybackTokenRequestHeaders
 * @param cachedPlaybackTokenRequestBody
 * @returns
 */
async function fetchReplacementPlaybackAccessToken(
  cachedPlaybackTokenRequestHeaders: Map<string, string> | null,
  cachedPlaybackTokenRequestBody: string | null,
  anonymousMode: boolean = false
): Promise<PlaybackAccessToken | null> {
  let request: Request | null = null;
  if (
    cachedPlaybackTokenRequestHeaders != null &&
    cachedPlaybackTokenRequestBody != null
  ) {
    request = new Request("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: Object.fromEntries(cachedPlaybackTokenRequestHeaders), // Headers already contain the flag.
      body: cachedPlaybackTokenRequestBody,
    });
  } else {
    // This fallback request is used when Twitch doesn't send a PlaybackAccessToken request.
    // This can happen when the user refreshes the page.
    request = getFallbackPlaybackAccessTokenRequest(null, anonymousMode);
  }
  if (request == null) return null;

  try {
    const response = await NATIVE_FETCH(request);
    const json = await response.json();
    const newPlaybackAccessToken = json?.data?.streamPlaybackAccessToken;
    if (newPlaybackAccessToken == null) return null;
    return newPlaybackAccessToken;
  } catch {
    return null;
  }
}

/**
 * Returns a new Usher URL with the new playback access token.
 * @param cachedUsherRequestUrl
 * @param playbackAccessToken
 * @returns
 */
function getReplacementUsherUrl(
  cachedUsherRequestUrl: string | null,
  playbackAccessToken: PlaybackAccessToken
): string | null {
  if (cachedUsherRequestUrl == null) return null; // Very unlikely.
  try {
    const newUsherUrl = new URL(cachedUsherRequestUrl);
    newUsherUrl.searchParams.delete("acmb");
    newUsherUrl.searchParams.set("play_session_id", generateRandomString(32));
    newUsherUrl.searchParams.set("sig", playbackAccessToken.signature);
    newUsherUrl.searchParams.set("token", playbackAccessToken.value);
    return newUsherUrl.toString();
  } catch {
    return null;
  }
}

/**
 * Fetches a new Usher manifest from Twitch.
 * @param cachedUsherRequestUrl
 * @param playbackAccessToken
 * @returns
 */
async function fetchReplacementUsherManifest(
  cachedUsherRequestUrl: string | null,
  playbackAccessToken: PlaybackAccessToken
): Promise<string | null> {
  if (cachedUsherRequestUrl == null) return null; // Very unlikely.
  try {
    const newUsherUrl = getReplacementUsherUrl(
      cachedUsherRequestUrl,
      playbackAccessToken
    );
    if (newUsherUrl == null) return null;
    const response = await NATIVE_FETCH(newUsherUrl);
    const text = await response.text();
    return text;
  } catch {
    return null;
  }
}

/**
 * Parses a Usher response and returns a map of video quality to URL.
 * @param manifest
 * @returns
 */
function parseUsherManifest(manifest: string): Map<string, string> | null {
  const parser = new m3u8Parser.Parser();
  parser.push(manifest);
  parser.end();
  const parsedManifest = parser.manifest;
  if (!parsedManifest.playlists || parsedManifest.playlists.length === 0) {
    return null;
  }
  return new Map(
    parsedManifest.playlists.map(playlist => [
      playlist.attributes.VIDEO,
      playlist.uri,
    ])
  );
}

/**
 * Updates the replacement Video Weaver URLs.
 * @param cachedUsherRequestUrl
 * @param videoWeaver
 * @returns
 */
async function updateVideoWeaverReplacementMap(
  cachedUsherRequestUrl: string | null,
  videoWeaver: VideoWeaver
): Promise<boolean> {
  console.log("[TTV LOL PRO] 🔄 Getting replacement Video Weaver URLs…");
  try {
    console.log("[TTV LOL PRO] 🔄 (1/3) Getting new PlaybackAccessToken…");
    const newPlaybackAccessTokenResponse =
      await sendMessageToPageScriptAndWaitForResponse(
        "worker",
        {
          type: MessageType.NewPlaybackAccessToken,
        },
        MessageType.NewPlaybackAccessTokenResponse
      );
    const newPlaybackAccessToken: PlaybackAccessToken | undefined =
      newPlaybackAccessTokenResponse?.newPlaybackAccessToken;
    if (newPlaybackAccessToken == null) {
      console.error("[TTV LOL PRO] ❌ Failed to get new PlaybackAccessToken.");
      return false;
    }

    console.log("[TTV LOL PRO] 🔄 (2/3) Fetching new Usher manifest…");
    const newUsherManifest = await fetchReplacementUsherManifest(
      cachedUsherRequestUrl,
      newPlaybackAccessToken
    );
    if (newUsherManifest == null) {
      console.error("[TTV LOL PRO] ❌ Failed to fetch new Usher manifest.");
      return false;
    }

    console.log("[TTV LOL PRO] 🔄 (3/3) Parsing new Usher manifest…");
    const replacementMap = parseUsherManifest(newUsherManifest);
    if (replacementMap == null || replacementMap.size === 0) {
      console.error("[TTV LOL PRO] ❌ Failed to parse new Usher manifest.");
      return false;
    }

    console.log(
      "[TTV LOL PRO] 🔄 Replacement Video Weaver URLs:",
      Object.fromEntries(replacementMap)
    );
    videoWeaver.replacementMap = replacementMap;

    // Send replacement Video Weaver URLs to content script.
    const videoWeaverUrls = [...replacementMap.values()];
    if (cachedUsherRequestUrl != null && videoWeaverUrls.length > 0) {
      sendMessageToContentScript({
        type: MessageType.UsherResponse,
        channel: findChannelFromUsherUrl(cachedUsherRequestUrl),
        videoWeaverUrls,
        proxyCountry:
          /USER-COUNTRY="([A-Z]+)"/i.exec(newUsherManifest)?.[1] || undefined,
      });
    }

    return true;
  } catch (error) {
    console.error(
      "[TTV LOL PRO] ❌ Failed to get replacement Video Weaver URLs:",
      error
    );
    return false;
  }
}

//#endregion
