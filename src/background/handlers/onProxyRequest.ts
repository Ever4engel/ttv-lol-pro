import { Proxy } from "webextension-polyfill";
import findChannelFromVideoWeaverUrl from "../../common/ts/findChannelFromVideoWeaverUrl";
import getHostFromUrl from "../../common/ts/getHostFromUrl";
import isChannelWhitelisted from "../../common/ts/isChannelWhitelisted";
import { usherHostRegex, videoWeaverHostRegex } from "../../common/ts/regexes";
import store from "../../store";
import type { ProxyInfo } from "../../types";

export default function onProxyRequest(
  details: Proxy.OnRequestDetailsType
): ProxyInfo | ProxyInfo[] | Promise<ProxyInfo | ProxyInfo[]> {
  const host = getHostFromUrl(details.url);
  if (!host) return { type: "direct" };

  // Usher requests.
  if (store.state.proxyUsherRequests && usherHostRegex.test(host)) {
    const proxies = store.state.usherProxies;
    const proxyInfoArray = getProxyInfoArrayFromHosts(proxies);
    console.log(
      `⌛ Proxying ${details.url} through one of: ${
        proxies.toString() || "<empty>"
      }`
    );
    return proxyInfoArray;
  }

  // Video-weaver requests.
  if (videoWeaverHostRegex.test(host)) {
    const proxies = store.state.videoWeaverProxies;
    const proxyInfoArray = getProxyInfoArrayFromHosts(proxies);
    // Don't proxy whitelisted channels.
    const channelName = findChannelFromVideoWeaverUrl(details.url);
    if (isChannelWhitelisted(channelName)) {
      console.log(`✋ Channel '${channelName}' is whitelisted.`);
      return { type: "direct" };
    }
    console.log(
      `⌛ Proxying ${details.url} (${
        channelName ?? "unknown"
      }) through one of: ${proxies.toString() || "<empty>"}`
    );
    return proxyInfoArray;
  }

  return { type: "direct" };
}

function getProxyInfoArrayFromHosts(hosts: string[]): ProxyInfo[] {
  return [
    ...hosts.map(host => {
      const [hostname, port] = host.split(":");
      return {
        type: "http",
        host: hostname,
        port: Number(port) ?? 3128,
      } as ProxyInfo;
    }),
    { type: "direct" } as ProxyInfo, // Fallback to direct connection if all proxies fail.
  ];
}
