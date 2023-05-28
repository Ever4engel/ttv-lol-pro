import acceptFlag from "../common/ts/acceptFlag";
import getHostFromUrl from "../common/ts/getHostFromUrl";
import { videoWeaverHostRegex } from "../common/ts/regexes";

const NATIVE_FETCH = self.fetch;

const knownVideoWeaverUrls = new Set<string>();
const flaggedVideoWeaverUrls = new Map<string, number>(); // URL -> No. of times flagged.

/**
 * Converts a HeadersInit to a map.
 * @param headers
 * @returns
 */
function getHeadersMap(
  headers: Headers | HeadersInit | undefined
): Map<string, string> {
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
  body: BodyInit | null | undefined
): Promise<string | null> {
  if (!body) return null;
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
  const accept = getHeaderFromMap(headersMap, "Accept");
  setHeaderToMap(headersMap, "Accept", `${accept || ""}${acceptFlag}`);
}

function cancelRequest(): never {
  throw new Error();
}

export async function fetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  console.debug("[TTV LOL PRO] 🥅 Caught fetch request.");
  const url = input instanceof Request ? input.url : input.toString();
  const host = getHostFromUrl(url);
  const headersMap = getHeadersMap(init?.headers);
  // const requestBody = await getRequestBodyText(init?.body);

  // Video Weaver requests.
  if (host != null && videoWeaverHostRegex.test(host)) {
    const isNewUrl = !knownVideoWeaverUrls.has(url);
    const isFlaggedUrl = flaggedVideoWeaverUrls.has(url);
    if (isNewUrl || isFlaggedUrl) {
      console.debug("[TTV LOL PRO] 🥅 Caught new or flagged Video Weaver URL.");
      flagRequest(headersMap);
      if (isNewUrl) knownVideoWeaverUrls.add(url);
      flaggedVideoWeaverUrls.set(
        url,
        (flaggedVideoWeaverUrls.get(url) ?? 0) + 1
      );
    }
  }

  const response = await NATIVE_FETCH(input, {
    ...init,
    headers: Object.fromEntries(headersMap),
  });
  const clonedResponse = response.clone();

  // Video Weaver responses.
  if (host != null && videoWeaverHostRegex.test(host)) {
    const responseBody = await clonedResponse.text();

    if (responseBody.includes("stitched")) {
      console.debug(
        "[TTV LOL PRO] 🥅 Caught Video Weaver response containing ad."
      );
      if (!flaggedVideoWeaverUrls.has(url)) {
        // Let's proxy the next request for this URL, 2 attempts left.
        flaggedVideoWeaverUrls.set(url, 0);
        cancelRequest();
      }
      // 0: First attempt, not proxied, cancelled.
      // 1: Second attempt, proxied, cancelled?
      // 2: Third attempt, proxied, last attempt by Twitch.
      // If the third attempt contains an ad, we have to let it through.
      const isCancellable = flaggedVideoWeaverUrls.get(url) < 2;
      if (isCancellable) {
        cancelRequest();
      } else {
        console.log(
          "[TTV LOL PRO] ❌ Could not cancel Video Weaver response containing ad. All attempts used."
        );
        flaggedVideoWeaverUrls.set(url, 0); // Reset attempts.
      }
    } else if (responseBody.includes("twitch-maf-ad")) {
      console.debug(
        "[TTV LOL PRO] 🥅 Caught Video Weaver response containing twitch-maf-ad."
      );
      const newReponseBody = responseBody
        .split("\n")
        .filter(line => {
          return !line.includes("twitch-maf-ad");
        })
        .join("\n");
      return new Response(newReponseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else {
      // No ad, remove from flagged list.
      flaggedVideoWeaverUrls.delete(url);
    }
  }

  return response;
}
