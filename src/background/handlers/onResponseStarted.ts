import { WebRequest } from "webextension-polyfill";
import findChannelFromTwitchTvUrl from "../../common/ts/findChannelFromTwitchTvUrl";
import findChannelFromVideoWeaverUrl from "../../common/ts/findChannelFromVideoWeaverUrl";
import getHostFromUrl from "../../common/ts/getHostFromUrl";
import getProxyInfoFromUrl from "../../common/ts/getProxyInfoFromUrl";
import isChromium from "../../common/ts/isChromium";
import isRequestTypeProxied from "../../common/ts/isRequestTypeProxied";
import {
  passportHostRegex,
  twitchGqlHostRegex,
  twitchTvHostRegex,
  usherHostRegex,
  videoWeaverHostRegex,
} from "../../common/ts/regexes";
import { getStreamStatus, setStreamStatus } from "../../common/ts/streamStatus";
import store from "../../store";
import { ProxyInfo, ProxyRequestType } from "../../types";

export default function onResponseStarted(
  details: WebRequest.OnResponseStartedDetailsType & {
    proxyInfo?: ProxyInfo;
  }
): void {
  const host = getHostFromUrl(details.url);
  if (!host) return;

  const proxy = getProxyFromDetails(details);

  const requestParams = {
    isChromium: isChromium,
    optimizedProxiesEnabled: store.state.optimizedProxiesEnabled,
    passportLevel: store.state.passportLevel,
  };
  const proxiedPassportRequest = isRequestTypeProxied(
    ProxyRequestType.Passport,
    requestParams
  );
  const proxiedUsherRequest = isRequestTypeProxied(
    ProxyRequestType.Usher,
    requestParams
  );
  const proxiedVideoWeaverRequest = isRequestTypeProxied(
    ProxyRequestType.VideoWeaver,
    requestParams
  );
  const proxiedGraphQLRequest = isRequestTypeProxied(
    ProxyRequestType.GraphQL,
    requestParams
  );
  const proxiedTwitchWebpageRequest = isRequestTypeProxied(
    ProxyRequestType.TwitchWebpage,
    requestParams
  );

  // Passport requests.
  if (proxiedPassportRequest && passportHostRegex.test(host)) {
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }

  // Usher requests.
  if (proxiedUsherRequest && usherHostRegex.test(host)) {
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }

  // Video-weaver requests.
  if (proxiedVideoWeaverRequest && videoWeaverHostRegex.test(host)) {
    const channelName =
      findChannelFromVideoWeaverUrl(details.url) ??
      findChannelFromTwitchTvUrl(details.documentUrl);
    const streamStatus = getStreamStatus(channelName);
    const stats = streamStatus?.stats ?? { proxied: 0, notProxied: 0 };
    if (!proxy) {
      stats.notProxied++;
      setStreamStatus(channelName, {
        proxied: false,
        proxyHost: streamStatus?.proxyHost ? streamStatus.proxyHost : undefined,
        proxyCountry: streamStatus?.proxyCountry,
        reason: `Proxied: ${stats.proxied} | Not proxied: ${stats.notProxied}`,
        stats,
      });
      console.log(
        `❌ Did not proxy ${details.url} (${channelName ?? "unknown"})`
      );
      return;
    }
    stats.proxied++;
    setStreamStatus(channelName, {
      proxied: true,
      proxyHost: proxy,
      proxyCountry: streamStatus?.proxyCountry,
      reason: `Proxied: ${stats.proxied} | Not proxied: ${stats.notProxied}`,
      stats,
    });
    console.log(
      `✅ Proxied ${details.url} (${channelName ?? "unknown"}) through ${proxy}`
    );
  }

  // Twitch GraphQL requests.
  if (proxiedGraphQLRequest && twitchGqlHostRegex.test(host)) {
    if (!proxy && store.state.optimizedProxiesEnabled) return; // Expected for most requests.
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }

  // Twitch webpage requests.
  if (proxiedTwitchWebpageRequest && twitchTvHostRegex.test(host)) {
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }
}

function getProxyFromDetails(
  details: WebRequest.OnResponseStartedDetailsType & {
    proxyInfo?: ProxyInfo;
  }
): string | null {
  if (isChromium) {
    const ip = details.ip;
    if (!ip) return null;
    const dnsResponse = store.state.dnsResponses.find(
      dnsResponse => dnsResponse.ips.indexOf(ip) !== -1
    );
    if (!dnsResponse) return null;
    const proxies = [
      ...store.state.optimizedProxies,
      ...store.state.normalProxies,
    ];
    const proxyInfoArray = proxies.map(getProxyInfoFromUrl);
    const possibleProxies = proxyInfoArray.filter(
      proxy => proxy.host === dnsResponse.host
    );
    if (possibleProxies.length === 1)
      return `${possibleProxies[0].host}:${possibleProxies[0].port}`;
    return dnsResponse.host;
  } else {
    const proxyInfo = details.proxyInfo; // Firefox only.
    if (!proxyInfo || proxyInfo.type === "direct") return null;
    return `${proxyInfo.host}:${proxyInfo.port}`;
  }
}
