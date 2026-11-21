/**
 * Egern「网络诊断雷达」· 透明版
 *
 * Glass fork: 透明版（WIDGET_STYLE 开关，glass 默认透明 / classic 原版）
 * glass 下根背景、卡片、色块、徽章底全部半透明（系统玻璃效果下实色会渲成白色）；
 * classic 为原版。文字、品牌色、纯净评分仪表盘（SVG）原样保留。
 *
 * 环境变量：
 * - POLICY：最高优先级。指定后，出口、延迟、流媒体、AI 全部统一走 POLICY
 * - LMT：流媒体检测策略组。POLICY 为空时生效
 * - AI：AI 检测策略组。POLICY 为空时生效
 * - YS=1：显示 IP 的地方启用隐私打码，例如 123.123.123.123 -> 123.123.*.*
 * - YS=0 或不设置：不打码
 * - XY：手动指定协议，例如 VLESS / Trojan / HY2 / AnyTLS
 * - XY 未设置：继续按原逻辑从 Egern 上下文 / 节点元数据 / 节点名尝试识别
 *
 * 策略优先级：
 * POLICY ＞ LMT / AI ＞ 单服务内置候选策略名匹配 ＞ 不指定 policy
 *
 * 单服务匹配逻辑：
 * - POLICY 为空，LMT/AI 也为空时，每个服务单独使用自己的候选策略名表
 * - 每个服务在本轮刷新中只匹配一次
 * - 匹配成功后缓存本轮结果
 * - 匹配不到时该服务不传 policy，走 Widget 默认请求方式
 * - 服务小国旗来自该服务实际使用策略的出口地区，不再复用顶部当前代理出口
 */

export default async function (ctx) {
  const env = ctx.env || {};
  // Glass fork: WIDGET_STYLE=glass（默认）根背景与卡片透明；classic 为原版
  const glass = String(env.WIDGET_STYLE || 'glass').trim().toLowerCase() !== 'classic';
  const C = palette(glass);
  const SCHEME = detectScheme(ctx);

  const POLICY = clean(env.POLICY);
  // Glass fork: 当前代理（出口、延迟）固定走 MAIN_POLICY，默认花云；不影响流媒体与 AI 各自的分组
  const MAIN_POLICY = clean(env.MAIN_POLICY) || "花云";
  const POLICY_LABEL = MAIN_POLICY || POLICY || "默认规则";
  const LMT_POLICY = clean(env.LMT);
  const AI_POLICY = clean(env.AI);
  const MASK_IP = clean(env.YS) === "1";
  const FORCE_PROTOCOL = clean(env.XY);

  const TIMEOUT = 4500;
  const POLICY_PROBE_TIMEOUT = 1800;
  const POLICY_PROBE_BATCH_SIZE = 6;
  const REFRESH_MINUTES = 15;
  const FORCE_LOCAL_MAINLAND = true;

  const servicePolicyCache = {};
  const policyProbeCache = {};
  const policyExitCache = {};

  const SCREEN_W = numberInRange(
    pick(getScreenMetric(ctx, "width"), 440),
    320,
    900,
    440
  );

  const SCREEN_H = numberInRange(
    pick(getScreenMetric(ctx, "height"), 956),
    568,
    1400,
    956
  );

  const WIDTH_SCALE = SCREEN_W / 440;
  const HEIGHT_SCALE = SCREEN_H / 956;
  const UI_SCALE = clamp(WIDTH_SCALE * 0.88 + HEIGHT_SCALE * 0.12, 0.9, 1.06);
  const FONT_SCALE = clamp(UI_SCALE, 0.9, 1.045);

  const CURRENT_PROXY = getCurrentProxyInfo(ctx);
  const NODE_PROTOCOL =
    protocolFromXY(FORCE_PROTOCOL) ||
    CURRENT_PROXY.protocol ||
    "未暴露";

  const MAINLAND_LATENCY_URLS = [
    "http://connect.rom.miui.com/generate_204",
    "http://wifi.vivo.com.cn/generate_204",
    "https://www.baidu.com/favicon.ico",
    "https://www.qq.com/favicon.ico",
    "https://www.aliyun.com/favicon.ico"
  ];

  const GLOBAL_PROXY_LATENCY_URLS = [
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
    "https://www.google.com/generate_204",
    "https://www.cloudflare.com/favicon.ico"
  ];

  const POLICY_PROBE_URLS = [
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
    "https://www.cloudflare.com/favicon.ico"
  ];

  // Glass fork: 按用户要求换服务——流媒体：Emby / Instagram / X（替换 Netflix / Disney+ / Prime）；
  // AI：Muse（Meta AI）/ 豆包（替换 Claude / Perplexity）；其余不动
  const MEDIA_SERVICE_IDS = [
    "emby",
    "instagram",
    "spotify",
    "tiktok",
    "youtube",
    "x"
  ];

  const AI_SERVICE_IDS = [
    "chatgpt",
    "muse",
    "gemini",
    "deepseek",
    "appleai",
    "doubao"
  ];

  const device = ctx.device || {};
  const wifi = device.wifi || {};
  const ipv4 = device.ipv4 || {};
  const ipv6 = device.ipv6 || {};

  const dnsServers = Array.isArray(device.dnsServers)
    ? device.dnsServers.filter(Boolean)
    : [];

  let networkName = getLocalNetworkName(device);

  const localIP =
    clean(
      pick(
        ipv4.address,
        wifi.ip,
        wifi.ipAddress,
        device.ipAddress,
        device.ip
      )
    ) || "未获取";

  const gateway =
    clean(
      pick(
        ipv4.gateway,
        wifi.gateway,
        device.gateway
      )
    ) || "未获取";

  const hasIPv4 = Boolean(clean(localIP)) && localIP !== "未获取";
  const hasIPv6 = Boolean(clean(pick(ipv6.address, device.ipv6Address)));
  const baseDNS = detectDNSProvider(dnsServers);
  const now = new Date();

  function S(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * UI_SCALE * 100) / 100;
  }

  function FS(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * FONT_SCALE * 100) / 100;
  }

  function displayIP(value) {
    return MASK_IP ? maskIP(value) : value;
  }

  function scaleStyle(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      return object;
    }

    const scaled = {};
    const scaleKeys = {
      width: true,
      height: true,
      gap: true,
      borderRadius: true,
      borderWidth: true,
      length: true
    };

    Object.keys(object).forEach(function (key) {
      const value = object[key];

      if (key === "padding" && Array.isArray(value)) {
        scaled[key] = value.map(function (item) {
          return S(item);
        });
      } else if (scaleKeys[key] && typeof value === "number") {
        scaled[key] = S(value);
      } else {
        scaled[key] = value;
      }
    });

    return scaled;
  }

  function uiColor(value) {
    return resolveAdaptiveColor(value, SCHEME);
  }

  function requestOptions(extra) {
    const options = {
      timeout: TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "application/json,text/plain,text/html,*/*",
        "Cache-Control": "no-cache"
      }
    };

    if (POLICY) {
      options.policy = POLICY;
    }

    return Object.assign(options, extra || {});
  }

  function directRequestOptions(extra) {
    return Object.assign(
      {
        timeout: TIMEOUT,
        redirect: "follow",
        credentials: "omit",
        policy: "DIRECT",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
          Accept: "application/json,text/plain,text/html,*/*",
          "Cache-Control": "no-cache"
        }
      },
      extra || {}
    );
  }

  function serviceRequestOptions(policy, extra) {
    const options = {
      timeout: TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    };

    const targetPolicy = clean(policy);

    if (targetPolicy) {
      options.policy = targetPolicy;
    }

    return Object.assign(options, extra || {});
  }

  function policyProbeRequestOptions(policy, extra) {
    const options = {
      timeout: POLICY_PROBE_TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    };

    const targetPolicy = clean(policy);

    if (targetPolicy) {
      options.policy = targetPolicy;
    }

    return Object.assign(options, extra || {});
  }

  async function getJSON(url) {
    try {
      const response = await ctx.http.get(url, requestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        data: null
      };
    }
  }

  async function getJSONDirect(url) {
    try {
      const response = await ctx.http.get(url, directRequestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        data: null
      };
    }
  }

  async function getText(url) {
    const startedAt = Date.now();

    try {
      const response = await ctx.http.get(url, requestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        text: (await response.text()) || "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        text: "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  // Glass fork: 按指定策略发请求（给当前代理的出口/延迟用）
  async function getJSONPolicy(url, policy) {
    try {
      const response = await ctx.http.get(url, serviceRequestOptions(policy));
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        data: null
      };
    }
  }

  async function getTextPolicy(url, policy) {
    const startedAt = Date.now();

    try {
      const response = await ctx.http.get(url, serviceRequestOptions(policy));
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        text: (await response.text()) || "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        text: "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  async function latencyProbePolicy(url, policy) {
    const startedAt = Date.now();

    try {
      const response = await ctx.http.get(url, serviceRequestOptions(policy));

      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    }
  }

  async function measureLatencySetPolicy(urls, policy) {
    const results = await Promise.all(
      urls.map(function (url) {
        return latencyProbePolicy(url, policy);
      })
    );

    const passed = results
      .filter(function (item) {
        return item.ok && item.ms > 0;
      })
      .sort(function (a, b) {
        return a.ms - b.ms;
      });

    if (passed.length === 0) {
      return {
        ok: false,
        ms: 0,
        target: ""
      };
    }

    const best = passed[0];

    return {
      ok: true,
      ms: best.ms,
      target: best.url
    };
  }

  async function getServiceStatus(url, servicePolicy) {
    const startedAt = Date.now();

    try {
      const response = await ctx.http.get(
        url,
        serviceRequestOptions(servicePolicy)
      );

      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        ms: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  async function getPolicyExit(policy) {
    const targetPolicy = clean(policy);
    const key = targetPolicy || "__DEFAULT__";

    if (!policyExitCache[key]) {
      policyExitCache[key] = (async function () {
        const urls = [
          "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" + Date.now(),
          "https://ipwho.is/?lang=zh-CN&_=" + Date.now(),
          "https://api.ipapi.is/?_=" + Date.now()
        ];

        for (let index = 0; index < urls.length; index += 1) {
          try {
            const response = await ctx.http.get(
              urls[index],
              serviceRequestOptions(targetPolicy, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
                  Accept: "application/json,text/plain,*/*",
                  "Cache-Control": "no-cache"
                }
              })
            );

            if (response.status < 200 || response.status >= 400) {
              continue;
            }

            const parsed = parsePolicyExit(await response.json());

            if (parsed && parsed.countryCode) {
              return parsed;
            }
          } catch (_) {}
        }

        return {
          ip: "",
          country: "",
          countryCode: "",
          city: "",
          region: "",
          label: "NET"
        };
      })();
    }

    return await policyExitCache[key];
  }

  function parsePolicyExit(data) {
    if (!data || typeof data !== "object") {
      return {
        ip: "",
        country: "",
        countryCode: "",
        city: "",
        region: "",
        label: "NET"
      };
    }

    const ip = clean(
      pick(
        data.query,
        data.ip,
        data.ip_address,
        getAt(data, "location.ip")
      )
    );

    const rawCountry = clean(
      pick(
        data.country,
        data.country_name,
        getAt(data, "location.country")
      )
    );

    const code = countryCode(
      pick(
        data.countryCode,
        data.country_code,
        getAt(data, "location.country_code"),
        rawCountry.length === 2 ? rawCountry : ""
      )
    );

    const region = clean(
      pick(
        data.regionName,
        data.region,
        getAt(data, "location.region")
      )
    );

    const city = clean(
      pick(
        data.city,
        getAt(data, "location.city")
      )
    );

    return {
      ip: ip,
      country: rawCountry,
      countryCode: code,
      city: city,
      region: region,
      label: code ? flag(code) + " " + code : "NET"
    };
  }

  async function probePolicy(policy) {
    const name = clean(policy);

    if (!name) {
      return false;
    }

    const key = name.toLowerCase();

    if (!policyProbeCache[key]) {
      policyProbeCache[key] = (async function () {
        const urls = POLICY_PROBE_URLS.map(function (url) {
          return url + "?_=" + Date.now() + randomAlphaNum(5);
        });

        for (let index = 0; index < urls.length; index += 1) {
          try {
            const response = await ctx.http.get(
              urls[index],
              policyProbeRequestOptions(name)
            );

            if (response.status >= 200 && response.status < 500) {
              return true;
            }
          } catch (_) {}
        }

        return false;
      })();
    }

    return await policyProbeCache[key];
  }

  async function firstWorkingPolicy(candidates) {
    const list = dedupeCandidates(candidates);

    for (let start = 0; start < list.length; start += POLICY_PROBE_BATCH_SIZE) {
      const batch = list.slice(start, start + POLICY_PROBE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(function (policy) {
          return probePolicy(policy);
        })
      );

      for (let index = 0; index < results.length; index += 1) {
        if (results[index]) {
          return batch[index];
        }
      }
    }

    return "";
  }

  async function resolveServicePolicy(serviceId, category) {
    const id = clean(serviceId).toLowerCase();
    const type = clean(category).toLowerCase();
    const cacheKey = type + ":" + id;

    if (Object.prototype.hasOwnProperty.call(servicePolicyCache, cacheKey)) {
      return servicePolicyCache[cacheKey];
    }

    let result = "";

    if (POLICY) {
      result = POLICY;
    } else if (type === "lmt" && LMT_POLICY) {
      result = LMT_POLICY;
    } else if (type === "ai" && AI_POLICY) {
      result = AI_POLICY;
    } else {
      result = await firstWorkingPolicy(
        servicePolicyCandidates(id, type)
      );
    }

    servicePolicyCache[cacheKey] = result;
    return result;
  }

  async function resolveServicePolicyMap(ids, category) {
    const entries = await Promise.all(
      ids.map(async function (id) {
        return [
          id,
          await resolveServicePolicy(id, category)
        ];
      })
    );

    const map = {};

    entries.forEach(function (entry) {
      map[entry[0]] = entry[1];
    });

    return map;
  }

  async function getExit() {
    const baseResults = await Promise.all([
      getJSONPolicy("https://api.ipapi.is/?_=" + Date.now(), MAIN_POLICY),
      getJSONPolicy(
        "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile&_=" +
          Date.now(),
        MAIN_POLICY
      ),
      getJSONPolicy("https://ipwho.is/?lang=zh-CN&_=" + Date.now(), MAIN_POLICY),
      getJSONPolicy("https://ipinfo.io/json?_=" + Date.now(), MAIN_POLICY)
    ]);

    const sourceNames = [
      "ipapi.is",
      "ip-api",
      "ipwho.is",
      "ipinfo"
    ];

    const candidates = [];

    for (let index = 0; index < baseResults.length; index += 1) {
      if (!baseResults[index].ok || !baseResults[index].data) {
        continue;
      }

      const parsed = parseExitSource(
        baseResults[index].data,
        sourceNames[index]
      );

      if (parsed.ip) {
        candidates.push(parsed);
      }
    }

    let merged = mergeExitSources(candidates);

    if (!merged.ip || merged.ip === "未识别") {
      return {
        ip: "未识别",
        city: "出口检测失败",
        region: "",
        country: "",
        countryCode: "",
        isp: "未知组织",
        kind: "未知网络",
        flags: {}
      };
    }

    const proxyCheck = await getProxyCheck(merged.ip);

    if (proxyCheck && proxyCheck.ip) {
      merged = mergeExitSources([merged, proxyCheck]);
    }

    return merged;
  }

  async function getLocalExit() {
    const results = await Promise.all([
      getJSONDirect(
        "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" +
          Date.now()
      ),
      getJSONDirect("https://ipwho.is/?lang=zh-CN&_=" + Date.now()),
      getJSONDirect("https://api.ipapi.is/?_=" + Date.now())
    ]);

    for (let index = 0; index < results.length; index += 1) {
      const parsed = parseLocalExit(
        results[index].data,
        FORCE_LOCAL_MAINLAND
      );

      if (results[index].ok && parsed.ip) {
        if (FORCE_LOCAL_MAINLAND && parsed.countryCode !== "CN") {
          return {
            ip: parsed.ip,
            city: "",
            region: "",
            country: "中国",
            countryCode: "CN",
            isp: parsed.isp || "",
            org: parsed.org || "",
            asname: parsed.asname || "",
            as: parsed.as || "",
            label: "中国大陆"
          };
        }

        return parsed;
      }
    }

    return {
      ip: "",
      city: "",
      region: "",
      country: "中国",
      countryCode: "CN",
      isp: "",
      org: "",
      asname: "",
      as: "",
      label: "中国大陆"
    };
  }

  async function getDNSVerified() {
    const results = await Promise.all([
      probeEDNSResolver(),
      probeEDNSResolver()
    ]);

    const valid = results.filter(function (item) {
      return item && item.ok && item.ip;
    });

    if (valid.length === 0) {
      return {
        ok: false,
        full: "",
        short: "",
        ip: "",
        geo: "",
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const primary = valid[0];

    const providerByText = providerFromText(
      [
        primary.geo,
        primary.ip,
        primary.isp,
        primary.org,
        primary.asname,
        primary.as
      ].join(" ")
    );

    if (providerByText.short) {
      return {
        ok: true,
        full: providerByText.full,
        short: providerByText.short,
        ip: primary.ip,
        geo: primary.geo,
        isp: primary.isp,
        org: primary.org,
        asname: primary.asname,
        as: primary.as
      };
    }

    const providerByIP = detectDNSProvider([primary.ip]);

    if (providerByIP.short && !isWeakDNSLabel(providerByIP.short)) {
      return {
        ok: true,
        full: providerByIP.full,
        short: providerByIP.short,
        ip: primary.ip,
        geo: primary.geo,
        isp: primary.isp,
        org: primary.org,
        asname: primary.asname,
        as: primary.as
      };
    }

    const ispLabel = compactDNSProviderName(
      primary.isp ||
      primary.org ||
      primary.asname ||
      primary.as ||
      primary.geo
    );

    return {
      ok: true,
      full: primary.isp || primary.org || primary.asname || primary.geo || "未知 DNS",
      short: ispLabel,
      ip: primary.ip,
      geo: primary.geo,
      isp: primary.isp,
      org: primary.org,
      asname: primary.asname,
      as: primary.as
    };
  }

  async function probeEDNSResolver() {
    const host = randomAlphaNum(32) + ".edns.ip-api.com";

    const result = await getJSONDirect(
      "http://" + host + "/json?_=" + Date.now()
    );

    if (!result.ok || !result.data) {
      return {
        ok: false,
        ip: "",
        geo: "",
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const dns = result.data.dns || {};
    const ip = clean(dns.ip);
    const geo = clean(dns.geo);

    if (!ip) {
      return {
        ok: false,
        ip: "",
        geo: geo,
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const info = await getDNSResolverInfo(ip);

    return {
      ok: true,
      ip: ip,
      geo: geo,
      isp: info.isp,
      org: info.org,
      asname: info.asname,
      as: info.as
    };
  }

  async function getDNSResolverInfo(ip) {
    const target = clean(ip);

    if (!target) {
      return {
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const result = await getJSONDirect(
      "http://ip-api.com/json/" +
        encodeURIComponent(target) +
        "?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" +
        Date.now()
    );

    if (!result.ok || !result.data || result.data.status === "fail") {
      return {
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    return {
      isp: clean(result.data.isp),
      org: clean(result.data.org),
      asname: clean(result.data.asname),
      as: clean(result.data.as)
    };
  }

  async function getProxyLatency() {
    const measured = await measureLatencySetPolicy(
      GLOBAL_PROXY_LATENCY_URLS,
      MAIN_POLICY
    );

    return {
      ok: measured.ok,
      ms: measured.ms,
      target: measured.target
    };
  }

  async function getLocalLatency() {
    const measured = await measureLatencySet(
      MAINLAND_LATENCY_URLS,
      true
    );

    return {
      ok: measured.ok,
      ms: measured.ms,
      target: measured.target
    };
  }

  async function measureLatencySet(urls, direct) {
    const results = await Promise.all(
      urls.map(function (url) {
        return latencyProbe(url, direct);
      })
    );

    const passed = results
      .filter(function (item) {
        return item.ok && item.ms > 0;
      })
      .sort(function (a, b) {
        return a.ms - b.ms;
      });

    if (passed.length === 0) {
      return {
        ok: false,
        ms: 0,
        target: ""
      };
    }

    const best = passed[0];

    return {
      ok: true,
      ms: best.ms,
      target: best.url
    };
  }

  async function latencyProbe(url, direct) {
    const startedAt = Date.now();

    try {
      const response = direct
        ? await ctx.http.get(url, directRequestOptions())
        : await ctx.http.get(url, requestOptions());

      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    }
  }

  async function getProxyCheck(ip) {
    const target = clean(ip);

    if (!target || target === "未识别") {
      return null;
    }

    const result = await getJSON(
      "https://proxycheck.io/v2/" +
        encodeURIComponent(target) +
        "?vpn=1&asn=1&risk=1&time=1&_=" +
        Date.now()
    );

    if (!result.ok || !result.data) {
      return null;
    }

    return parseProxyCheck(result.data, target);
  }

  async function testService(id, name, kind, color, url, servicePolicy) {
    const serviceExitPromise = getPolicyExit(servicePolicy);

    if (!url) {
      const emptyExit = await serviceExitPromise;

      return {
        id: id,
        name: name,
        kind: kind,
        color: color,
        ok: false,
        policy: servicePolicy || "",
        countryCode: emptyExit.countryCode || "",
        country: emptyExit.country || "",
        exit: emptyExit
      };
    }

    const separator = url.includes("?") ? "&" : "?";

    const [
      result,
      serviceExit
    ] = await Promise.all([
      getServiceStatus(
        url + separator + "_=" + Date.now(),
        servicePolicy
      ),
      serviceExitPromise
    ]);

    return {
      id: id,
      name: name,
      kind: kind,
      color: color,
      ok: result.ok,
      policy: servicePolicy || "",
      countryCode: serviceExit.countryCode || "",
      country: serviceExit.country || "",
      exit: serviceExit
    };
  }

  const [
    mediaPolicyMap,
    aiPolicyMap
  ] = await Promise.all([
    resolveServicePolicyMap(MEDIA_SERVICE_IDS, "lmt"),
    resolveServicePolicyMap(AI_SERVICE_IDS, "ai")
  ]);

  const [
    exit,
    localExit,
    verifiedDNS,
    proxyLatency,
    localLatency,
    media,
    ai
  ] = await Promise.all([
    getExit(),
    getLocalExit(),
    getDNSVerified(),
    getProxyLatency(),
    getLocalLatency(),

    Promise.all([
      testService("emby", "Emby", "emby", C.emby, "https://emby.media/", mediaPolicyMap.emby),
      testService("instagram", "Instagram", "instagram", C.instagram, "https://www.instagram.com/", mediaPolicyMap.instagram),
      testService("spotify", "Spotify", "spotify", C.spotify, "https://open.spotify.com/", mediaPolicyMap.spotify),
      testService("tiktok", "TikTok", "tiktok", C.tiktok, "https://www.tiktok.com/", mediaPolicyMap.tiktok),
      testService("youtube", "YouTube", "youtube", C.youtube, "https://www.youtube.com/", mediaPolicyMap.youtube),
      testService("x", "X", "x", C.x, "https://api.x.com/", mediaPolicyMap.x)
    ]),

    Promise.all([
      testService("chatgpt", "ChatGPT", "chatgpt", C.chatgpt, "https://chatgpt.com/", aiPolicyMap.chatgpt),
      testService("muse", "Muse", "muse", C.muse, "https://www.meta.ai/", aiPolicyMap.muse),
      testService("gemini", "Gemini", "gemini", C.gemini, "https://generativelanguage.googleapis.com/", aiPolicyMap.gemini),
      testService("deepseek", "DeepSeek", "deepseek", C.deepseek, "https://chat.deepseek.com/", aiPolicyMap.deepseek),
      testService("appleai", "苹果AI", "appleai", C.appleai, "https://guzzoni.apple.com/", aiPolicyMap.appleai),
      testService("doubao", "豆包", "doubao", C.doubao, "https://www.doubao.com/", aiPolicyMap.doubao)
    ])
  ]);

  const carrierByDirectISP = carrierFromISP(
    [
      localExit.isp,
      localExit.org,
      localExit.asname,
      localExit.as
    ].join(" ")
  );

  if (!networkName && carrierByDirectISP) {
    networkName = carrierByDirectISP;
  }

  if (!networkName) {
    networkName = "移动数据";
  }

  const dns = chooseDNSProvider(baseDNS, verifiedDNS);
  const dnsLabel = dnsTinyLabel(dns.short || dns.full);
  const localArea = localExit.label || "中国大陆";
  const nat = detectNAT(localIP, exit.ip);
  const purity = purityScore(exit);
  const risk = riskLevel(exit, purity);

  const proxyLatencyColor = proxyLatency.ok
    ? proxyLatency.ms <= 220 ? C.green : C.amber
    : C.red;

  const localLatencyColor = localLatency.ok
    ? localLatency.ms <= 220 ? C.green : C.amber
    : C.red;

  const natColor = toneColor(nat.tone, C);

  const purityColor =
    purity.score >= 75 ? C.green :
    purity.score >= 45 ? C.amber :
    C.red;

  const riskColor =
    risk === "低风险" ? C.green :
    risk === "中风险" ? C.amber :
    C.red;

  function merge(base, extra) {
    return scaleStyle(Object.assign({}, base || {}, extra || {}));
  }

  function text(value, size, weight, color, extra) {
    return merge(
      {
        type: "text",
        text: String(value),
        font: {
          size: FS(size),
          weight: weight || "regular"
        },
        textColor: color || C.text
      },
      extra
    );
  }

  function image(symbol, color, width, height, extra) {
    return merge(
      {
        type: "image",
        src: "sf-symbol:" + symbol,
        color: color || C.text,
        width: width || 10,
        height: height || 10
      },
      extra
    );
  }

  function rawImage(src, width, height, extra) {
    return merge(
      {
        type: "image",
        src: src,
        width: width,
        height: height,
        resizable: true
      },
      extra || {}
    );
  }

  function svgImage(svg, width, height, extra) {
    return rawImage(svgDataURI(svg), width, height, extra);
  }

  function row(children, extra) {
    return merge(
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: children || []
      },
      extra
    );
  }

  function col(children, extra) {
    return merge(
      {
        type: "stack",
        direction: "column",
        alignItems: "start",
        children: children || []
      },
      extra
    );
  }

  function spacer(length) {
    return length === undefined
      ? { type: "spacer" }
      : { type: "spacer", length: S(length) };
  }

  function card(children, extra) {
    return merge(
      {
        type: "stack",
        direction: "column",
        alignItems: "start",
        padding: [7, 8],
        gap: 4,
        backgroundColor: glass ? "#00000000" : C.card,
        ...(glass ? {} : {
          backgroundGradient: {
            type: "linear",
            colors: [C.cardTop, C.cardBottom],
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 1, y: 1 }
          }
        }),
        borderRadius: 14,
        borderWidth: glass ? 0 : 1,
        borderColor: C.cardBorder,
        children: children || []
      },
      extra
    );
  }

  function pill(value, tone, fill, extra) {
    return row(
      [
        text(value, 6, "semibold", tone, {
          maxLines: 1,
          minScale: 0.72,
          textAlign: "center"
        })
      ],
      merge(
        {
          padding: [2, 5],
          backgroundColor: fill,
          borderRadius: 8
        },
        extra
      )
    );
  }

  function proxyTagLine(value, tone, fill) {
    return row(
      [
        text(value, 4.7, "semibold", tone, {
          maxLines: 1,
          minScale: 0.42,
          textAlign: "center"
        })
      ],
      {
        width: 37,
        height: 7.2,
        padding: [0.7, 2.5],
        backgroundColor: fill,
        borderRadius: 4.8,
        alignItems: "center"
      }
    );
  }

  function proxyTagRows(tagOne, tagTwo, toneOne, fillOne, toneTwo, fillTwo) {
    return col(
      [
        proxyTagLine(tagOne, toneOne, fillOne),
        proxyTagLine(tagTwo, toneTwo, fillTwo)
      ],
      {
        width: 39,
        gap: 1,
        alignItems: "start"
      }
    );
  }

  function iconBox(symbol, tone, fill, side) {
    return row(
      [
        image(
          symbol,
          tone,
          Math.round(side * 0.52),
          Math.round(side * 0.52)
        )
      ],
      {
        width: side,
        height: side,
        padding: 3,
        backgroundColor: fill,
        borderRadius: 12
      }
    );
  }

  function sectionTitle(symbol, title, right, tone) {
    const children = [
      image(symbol, tone, 12, 12),
      text(title, 11, "semibold", C.text, {
        maxLines: 1
      })
    ];

    if (right) {
      children.push(spacer());
      children.push(right);
    }

    return row(children, { gap: 3 });
  }

  function metricBox(symbol, label, value, tone, extra) {
    const options = extra || {};
    const valueSize = options.valueSize || 6.1;
    const valueMinScale = options.valueMinScale || 0.35;
    const labelSize = options.labelSize || 5;
    const labelMinScale = options.labelMinScale || 0.72;

    return col(
      [
        row(
          [
            image(symbol, tone, 7, 7),
            text(label, labelSize, "medium", C.muted, {
              maxLines: 1,
              minScale: labelMinScale,
              textAlign: "center"
            })
          ],
          {
            gap: 1,
            alignItems: "center"
          }
        ),

        text(value, valueSize, "semibold", tone, {
          maxLines: 1,
          minScale: valueMinScale,
          textAlign: "center"
        })
      ],
      {
        flex: 1,
        height: 24,
        padding: [0, 0],
        gap: 0,
        alignItems: "center"
      }
    );
  }

  function header() {
    return row(
      [
        row(
          [
            iconBox("waveform.path.ecg", C.blue, C.blueSoft, 35),

            col(
              [
                row(
                  [
                    text("网络诊断雷达", 13, "bold", C.text, {
                      maxLines: 1,
                      minScale: 0.72
                    }),

                    pill("Pro", C.purple, C.purpleSoft, {
                      padding: [1, 4]
                    })
                  ],
                  {
                    gap: 3,
                    alignItems: "center"
                  }
                ),

                text("Egern · 全面网络状态检测", 7, "medium", C.muted, {
                  maxLines: 1,
                  minScale: 0.78
                })
              ],
              {
                flex: 1,
                gap: 0
              }
            )
          ],
          {
            width: 171,
            height: 34,
            gap: 6
          }
        ),

        row(
          [
            spacer(),

            image("scope", C.purple, 11, 11),

            col(
              [
                text("当前策略", 5, "medium", C.muted, {
                  maxLines: 1,
                  textAlign: "center"
                }),

                row(
                  [
                    text(
                      MAIN_POLICY ? "●" : "○",
                      7,
                      "bold",
                      MAIN_POLICY ? C.green : C.purple
                    ),

                    text(POLICY_LABEL, 7, "semibold", C.text, {
                      maxLines: 1,
                      minScale: 0.72
                    })
                  ],
                  {
                    gap: 2,
                    alignItems: "center"
                  }
                )
              ],
              {
                width: 52,
                gap: 0,
                alignItems: "start"
              }
            ),

            spacer()
          ],
          {
            flex: 1,
            height: 34,
            padding: [3, 0],
            gap: 3
          }
        ),

        col(
          [
            text(timeLabel(now), 11, "bold", C.text, {
              maxLines: 1,
              minScale: 0.82,
              textAlign: "right"
            }),

            text(dateLabel(now), 5, "medium", C.muted, {
              maxLines: 1,
              minScale: 0.82,
              textAlign: "right"
            })
          ],
          {
            width: 43,
            height: 34,
            alignItems: "end",
            gap: 0
          }
        )
      ],
      {
        height: 34,
        gap: 4
      }
    );
  }

  function localCard() {
    return card(
      [
        sectionTitle(
          "wifi",
          "本地网络",
          image("globe.asia.australia.fill", C.blue, 12, 12),
          C.blue
        ),

        row(
          [
            iconBox("wifi", C.blue, C.blueSoft, 58),

            col(
              [
                pill("已连接", C.green, C.greenSoft, {
                  padding: [1, 4]
                }),

                text(displayIP(localIP), 8, "medium", C.subtext, {
                  maxLines: 1,
                  minScale: 0.72
                }),

                row(
                  [
                    text(flag(localExit.countryCode) || "🇨🇳", 8, "regular", C.text),

                    text(localArea, 7, "medium", C.muted, {
                      maxLines: 1,
                      minScale: 0.72
                    })
                  ],
                  { gap: 2 }
                )
              ],
              {
                flex: 1,
                gap: 1
              }
            )
          ],
          { gap: 6 }
        ),

        row(
          [
            metricBox(
              "router.fill",
              "网关",
              gatewayLabel(displayIP(gateway)),
              C.blue,
              {
                valueSize: 5.4,
                valueMinScale: 0.28
              }
            ),

            metricBox(
              "clock",
              "直连延迟",
              localLatency.ok ? localLatency.ms + "ms" : "失败",
              localLatencyColor
            ),

            metricBox(
              "network",
              "IPV4/IPV6",
              (hasIPv4 ? "✓" : "×") + "/" + (hasIPv6 ? "✓" : "×"),
              hasIPv4 && hasIPv6
                ? C.green
                : hasIPv4
                  ? C.amber
                  : C.red
            ),

            metricBox(
              "cloud.fill",
              "DNS",
              dnsLabel,
              C.purple,
              {
                valueSize: 5.4,
                valueMinScale: 0.28
              }
            )
          ],
          { gap: 2 }
        )
      ],
      {
        flex: 1,
        height: 122
      }
    );
  }

  function flagBox() {
    return row(
      [
        text(flag(exit.countryCode) || "🌐", 22, "regular", C.text, {
          maxLines: 1,
          textAlign: "center"
        })
      ],
      {
        width: 46,
        height: 46,
        padding: 2,
        backgroundColor: C.purpleSoft,
        borderRadius: 11
      }
    );
  }

  function scoreGauge() {
    return svgImage(
      purityGaugeSVG(
        purity.score,
        {
          track: uiColor(C.scoreTrack),
          left: uiColor(C.scoreLeft),
          right: uiColor(C.scoreRight),
          glow: uiColor(C.scoreGlow),
          text: uiColor(C.scoreLeft),
          muted: uiColor(C.muted)
        }
      ),
      78,
      60,
      {
        borderRadius: 16
      }
    );
  }

  function proxyCard() {
    const city =
      clean(exit.city) ||
      clean(exit.country) ||
      "未知地区";

    const tagOne = exit.kind || "未知网络";

    const tagTwo =
      clean(exit.cloudProvider) ||
      (
        exit.kind === "住宅 IP"
          ? "原生住宅"
          : exit.kind === "移动网络"
            ? "移动出口"
            : exit.kind === "商业机房"
              ? "商业机房"
              : "出口网络"
      );

    const tagOneTone =
      exit.kind === "商业机房"
        ? C.amber
        : C.green;

    const tagOneFill =
      exit.kind === "商业机房"
        ? C.amberSoft
        : C.greenSoft;

    const tagTwoTone = C.green;
    const tagTwoFill = C.greenSoft;

    return card(
      [
        sectionTitle(
          "point.3.connected.trianglepath.dotted",
          "当前代理",
          pill(
            proxyLatency.ok ? "连接正常" : "检测失败",
            proxyLatency.ok ? C.green : C.red,
            proxyLatency.ok ? C.greenSoft : C.redSoft
          ),
          C.purple
        ),

        row(
          [
            flagBox(),

            col(
              [
                row(
                  [
                    text(flag(exit.countryCode) || "🌐", 7, "regular", C.text),

                    text(city, 9.2, "semibold", C.text, {
                      flex: 1,
                      maxLines: 1,
                      minScale: 0.55
                    })
                  ],
                  { gap: 2 }
                ),

                text(shortISP(exit.isp), 7.2, "medium", C.subtext, {
                  maxLines: 1,
                  minScale: 0.62
                }),

                proxyTagRows(
                  tagOne,
                  tagTwo,
                  tagOneTone,
                  tagOneFill,
                  tagTwoTone,
                  tagTwoFill
                )
              ],
              {
                flex: 1,
                gap: 1
              }
            ),

            row(
              [
                scoreGauge()
              ],
              {
                width: 68,
                height: 52,
                alignItems: "center",
                justifyContent: "center"
              }
            )
          ],
          {
            gap: 4,
            alignItems: "center"
          }
        ),

        row(
          [
            metricBox(
              "clock",
              "延迟",
              proxyLatency.ok ? proxyLatency.ms + "ms" : "失败",
              proxyLatencyColor
            ),

            metricBox(
              "circle.hexagongrid.fill",
              "NAT",
              nat.label,
              natColor
            ),

            metricBox(
              "slider.horizontal.3",
              "协议",
              NODE_PROTOCOL,
              C.purple,
              {
                valueSize: 5.4,
                valueMinScale: 0.34
              }
            )
          ],
          { gap: 2 }
        )
      ],
      {
        flex: 1,
        height: 122,
        padding: [5, 6],
        gap: 3
      }
    );
  }

const BRAND_SVG = {
  emby: "<svg fill=\"#52B54B\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Emby</title><path d=\"M11.041 0c-.007 0-1.456 1.43-3.219 3.176L4.615 6.352l.512.513.512.512-2.819 2.791L0 12.961l1.83 1.848c1.006 1.016 2.438 2.46 3.182 3.209l1.351 1.359.508-.496c.28-.273.515-.498.524-.498.008 0 1.266 1.264 2.794 2.808L12.97 24l.187-.182c.23-.225 5.007-4.95 5.717-5.656l.52-.516-.502-.513c-.276-.282-.5-.52-.496-.53.003-.009 1.264-1.26 2.802-2.783 1.538-1.522 2.8-2.776 2.803-2.785.005-.012-3.617-3.684-6.107-6.193L17.65 4.6l-.505.505c-.279.278-.517.501-.53.497-.013-.005-1.27-1.267-2.793-2.805A449.655 449.655 0 0011.041 0zM9.223 7.367c.091.038 7.951 4.608 7.957 4.627.003.013-1.781 1.056-3.965 2.32a999.898 999.898 0 01-3.996 2.307c-.019.006-.026-1.266-.026-4.629 0-3.7.007-4.634.03-4.625Z\"/></svg>",
  instagram: "<svg fill=\"#FF0069\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Instagram</title><path d=\"M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077\"/></svg>",
  spotify: "<svg fill=\"#1ED760\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Spotify</title><path d=\"M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z\"/></svg>",
  muse: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 68\"><path fill=\"#0082FB\" d=\"M24.626,0C28.236,0 30.819,2.819 30.819,7.243C30.819,11.665 30.105,15.655 28.922,24.125C28.074,30.06 26.62,39.12 26.013,42.887C27.178,40.66 29.907,35.454 30.391,34.477C36.108,22.94 42.066,12.633 43.783,9.904C46.059,6.261 48.062,4.801 51.16,4.801C52.769,4.802 54.683,5.614 55.632,6.698C56.918,8.168 57.186,10.539 57.141,13.123C57.074,17.086 56.56,23.405 55.855,30.448C55.542,33.584 54.937,39.985 54.529,44.279C58.188,37.732 64.961,25.689 67.692,21.484C70.073,17.819 72.466,15.458 75.684,15.458C78.46,15.458 81.881,17.42 81.677,22.636C81.377,30.334 80.267,47.102 79.761,54.627C83.166,49.67 87.638,42.333 89.315,39.575C91.01,36.787 92.75,34.533 95.39,34.456C98.099,34.378 99.913,36.22 99.996,39.062C100.078,41.906 98.383,45.104 96.134,48.735C93.694,52.674 90.962,56.891 87.638,60.828C84.315,64.764 81.26,67.757 76.599,67.757C72.424,67.757 69.487,64.983 69.283,59.904C69.177,57.243 69.68,51.519 70.06,47.046C70.5,41.866 71.031,36.865 71.403,33.557C67.734,40.276 60.01,54.346 56.535,59.839C53.134,65.213 51.477,67.106 47.888,67.106C44.298,67.106 42.723,64.52 42.672,60.628C42.614,56.407 45.785,31.061 46.859,22.616C45.118,26.34 40.839,35.484 38.155,40.922C35.559,46.184 31.204,55.276 28.044,60.514C25.767,64.288 23.209,67.106 19.417,67.106C15.625,67.106 13.485,64.557 13.485,60.457C13.485,56.358 14.672,49.528 15.947,41.056C16.584,36.957 17.311,32.492 18.131,27.755C18.732,24.327 19.776,18.295 20.418,14.591C17.502,19.133 12.254,27.306 10.657,29.769C8.881,32.508 7.287,34.505 4.647,34.505C1.733,34.505 0.001,32.231 0,29.59C0,26.949 1.343,24.913 3.524,21.33C6.324,16.725 11.358,10.449 14.115,7.153C17.366,3.27 20.614,0 24.626,0Z\"/></svg>",
  gemini: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#4285F4\" d=\"M12 1.5 L14.2 9.8 L22.5 12 L14.2 14.2 L12 22.5 L9.8 14.2 L1.5 12 L9.8 9.8 Z\"/></svg>",
  deepseek: "<svg fill=\"#5786FE\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>DeepSeek</title><path d=\"M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45\"/></svg>",
  tiktok: "<svg fill=\"#000000\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>TikTok</title><path d=\"M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z\"/></svg>",
  chatgpt: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 2406 2406\"><g transform=\"rotate(0 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g><g transform=\"rotate(60 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g><g transform=\"rotate(120 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g><g transform=\"rotate(180 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g><g transform=\"rotate(240 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g><g transform=\"rotate(300 1203 1203)\"><path d=\"M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z\" fill=\"#000000\"/></g></svg>"
};

  function serviceLogoLarge(item) {
    const base = {
      width: 28,
      height: 28,
      padding: 2,
      backgroundColor: C.tileIconBg,
      borderRadius: 7
    };

    if (BRAND_SVG[item.kind]) {
      return row(
        [
          svgImage(BRAND_SVG[item.kind], 15, 15)
        ],
        base
      );
    }

    if (item.kind === "spotify") {
      return row(
        [
          image("dot.radiowaves.left.and.right", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "tiktok") {
      return row(
        [
          image("music.note", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "youtube") {
      return row(
        [
          image("play.rectangle.fill", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "prime") {
      return row(
        [
          image("play.tv.fill", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "instagram") {
      return row(
        [
          image("camera.fill", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "appleai") {
      return row(
        [
          image("apple.logo", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "chatgpt") {
      return row(
        [
          image("circle.hexagongrid", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "grok") {
      return row(
        [
          image("xmark", item.color, 14, 14)
        ],
        base
      );
    }

    if (item.kind === "perplexity") {
      return row(
        [
          image("magnifyingglass", item.color, 14, 14)
        ],
        base
      );
    }

    const mark =
      item.kind === "netflix"
        ? "N"
        : item.kind === "disney"
          ? "D+"
          : item.kind === "deepseek"
            ? "D"
            : item.kind === "emby"
              ? "E"
              : item.kind === "x"
                ? "X"
                : item.kind === "muse"
                  ? "M"
                  : item.kind === "doubao"
                    ? "豆"
                    : "AI";

    const fontSize =
      item.kind === "claude"
        ? 10
        : item.kind === "disney"
          ? 10
          : 13;

    return row(
      [
        text(mark, fontSize, "bold", item.color, {
          maxLines: 1,
          textAlign: "center"
        })
      ],
      base
    );
  }

  function compactServiceTile(item) {
    const statusColor = item.ok ? C.green : C.red;
    const serviceCountryCode =
      countryCode(item.countryCode) ||
      countryCode(exit.countryCode);

    const serviceRegionLabel = serviceCountryCode
      ? flag(serviceCountryCode) + " " + serviceCountryCode
      : "NET";

    return row(
      [
        serviceLogoLarge(item),

        col(
          [
            text(item.name, 9, "semibold", C.text, {
              maxLines: 1,
              minScale: 0.66
            }),

            row(
              [
                text(
                  serviceRegionLabel,
                  5,
                  "medium",
                  C.subtext,
                  {
                    maxLines: 1
                  }
                ),

                text(
                  item.ok ? "OK" : "失败",
                  7,
                  "semibold",
                  statusColor,
                  {
                    maxLines: 1
                  }
                )
              ],
              { gap: 2 }
            )
          ],
          {
            flex: 1,
            gap: 1
          }
        )
      ],
      {
        flex: 1,
        height: 42,
        padding: [6, 6],
        gap: 4,
        backgroundColor: glass ? "#00000000" : C.tileBg,
        borderRadius: 9,
        borderWidth: glass ? 0 : 1,
        borderColor: C.tileBorder
      }
    );
  }

  function serviceGrid(items) {
    return col(
      [
        row(
          [
            compactServiceTile(items[0]),
            compactServiceTile(items[1])
          ],
          {
            height: 42,
            gap: 5
          }
        ),

        row(
          [
            compactServiceTile(items[2]),
            compactServiceTile(items[3])
          ],
          {
            height: 42,
            gap: 5
          }
        ),

        row(
          [
            compactServiceTile(items[4]),
            compactServiceTile(items[5])
          ],
          {
            height: 42,
            gap: 5
          }
        )
      ],
      {
        flex: 1,
        height: 134,
        gap: 4
      }
    );
  }

  function serviceCard(title, symbol, items, tone) {
    const passed = items.filter(item => item.ok).length;

    return card(
      [
        sectionTitle(
          symbol,
          title,
          pill(
            passed + "/" + items.length,
            passed === items.length ? C.green : C.amber,
            passed === items.length ? C.greenSoft : C.amberSoft
          ),
          tone
        ),

        serviceGrid(items)
      ],
      {
        flex: 1,
        height: 166,
        padding: [6, 7],
        gap: 5
      }
    );
  }

  function footerCell(symbol, label, value, tone) {
    return col(
      [
        row(
          [
            image(symbol, tone, 18, 18),

            col(
              [
                text(label, 8, "medium", C.muted, {
                  maxLines: 1
                }),

                text(value, 9, "semibold", tone, {
                  maxLines: 1,
                  minScale: 0.64
                })
              ],
              {
                flex: 1,
                gap: 0
              }
            )
          ],
          {
            gap: 4
          }
        )
      ],
      {
        flex: 1,
        padding: [2, 3]
      }
    );
  }

  function footer() {
    return card(
      [
        row(
          [
            footerCell(
              "server.rack",
              "ISP / 厂商",
              shortISP(exit.isp),
              C.blue
            ),

            footerCell(
              "house.fill",
              "属性类型",
              exit.kind,
              exit.kind === "商业机房"
                ? C.amber
                : C.green
            ),

            footerCell(
              "checkmark.shield.fill",
              "纯净评分",
              purity.score + "分",
              purityColor
            ),

            footerCell(
              "shield.lefthalf.filled",
              "风险等级",
              risk,
              riskColor
            ),

            footerCell(
              "arrow.clockwise",
              "更新时间",
              timeLabel(now),
              C.purple
            )
          ],
          {
            height: 28,
            padding: [0, 0],
            gap: 0,
            alignItems: "center"
          }
        )
      ],
      {
        height: 38,
        padding: [5, 5],
        gap: 0
      }
    );
  }

  const dashboard = col(
    [
      header(),

      row(
        [
          localCard(),
          proxyCard()
        ],
        {
          height: 122,
          gap: 6,
          alignItems: "start"
        }
      ),

      row(
        [
          serviceCard("流媒体解锁", "play.rectangle.fill", media, C.blue),
          serviceCard("AI 解锁检测", "sparkles", ai, C.purple)
        ],
        {
          height: 166,
          gap: 6,
          alignItems: "start"
        }
      ),

      footer()
    ],
    {
      // Glass fork: 大号自适应——flex 撑满 widget 高度，不留底边空白（原固定 342 在 iPhone Air 大号上留白）
      flex: 1,
      padding: [2, 2],
      gap: 8
    }
  );

  return {
    type: "widget",
    padding: S(2),
    gap: 0,
    backgroundColor: C.root,
    refreshAfter: new Date(
      Date.now() + REFRESH_MINUTES * 60 * 1000
    ).toISOString(),
    children: [
      dashboard,
      spacer()
    ]
  };
}

function palette(glass) {
  const adaptive = (light, dark) => ({
    light: light,
    dark: dark
  });
  // glass 下实色面改为半透明：系统玻璃效果会把实色渲成白色，半透明底才能看清字
  const surface = (light, dark) => glass
    ? { light: 'rgba(255,255,255,0.55)', dark: 'rgba(255,255,255,0.08)' }
    : adaptive(light, dark);
  const surfaceLight = (light, dark) => glass
    ? { light: 'rgba(255,255,255,0.35)', dark: 'rgba(255,255,255,0.06)' }
    : adaptive(light, dark);
  const line = (light, dark) => glass
    ? { light: 'rgba(255,255,255,0.5)', dark: 'rgba(255,255,255,0.16)' }
    : adaptive(light, dark);

  return {
    root: glass ? "#00000000" : adaptive("#E3EAF5", "#07101F"),

    dashboard: glass ? "#00000000" : adaptive("#E3EAF5", "#07101F"),
    dashboardBorder: line("#E3EAF5", "#07101F"),

    card: surface("#F7FAFF", "#101A2D"),
    cardTop: surface("#FFFFFF", "#142039"),
    cardBottom: surface("#F0F5FF", "#0D1728"),

    proxyTop: surface("#FFFFFF", "#142039"),
    proxyBottom: surface("#F0F5FF", "#0D1728"),

    cardBorder: line("#B5C7E5", "#30476F"),

    tileBg: surfaceLight("#EDF3FC", "#162238"),
    tileIconBg: surfaceLight("#DFE9F8", "#1D3154"),
    tileBorder: line("#B7C8E6", "#2E4876"),

    scoreTrack: adaptive("#D8E1EA", "#273045"),
    scoreGlow: adaptive("#1AE27F", "#1AE27F"),
    scoreLeft: adaptive("#22C96D", "#3BE28A"),
    scoreRight: adaptive("#E25769", "#FF627A"),

    footerDivider: line("#C7D2E6", "#32486D"),

    text: adaptive("#18253F", "#F1F5FF"),
    subtext: adaptive("#4E617F", "#BBC8E0"),
    muted: adaptive("#74839A", "#8694AE"),

    blue: adaptive("#2E74D2", "#70AEFF"),
    blueSoft: surfaceLight("#DDEAFF", "#183B71"),

    purple: adaptive("#7C63D8", "#B09AFF"),
    purpleSoft: surfaceLight("#EAE3FF", "#31275A"),

    green: adaptive("#229B62", "#58D79D"),
    greenSoft: surfaceLight("#DDF7E8", "#163F34"),

    amber: adaptive("#B9821D", "#FFC866"),
    amberSoft: surfaceLight("#FFF0D0", "#503918"),

    red: adaptive("#D64A59", "#FF7D88"),
    redSoft: surfaceLight("#FFE2E6", "#4A232C"),

    netflix: adaptive("#E50914", "#FF505B"),
    disney: adaptive("#2B76D8", "#7DB7FF"),
    spotify: adaptive("#1DB954", "#1ED760"),
    tiktok: adaptive("#111827", "#FFFFFF"),
    youtube: adaptive("#FF0033", "#FF4B4B"),
    prime: adaptive("#1978CC", "#7CB8FF"),

    chatgpt: adaptive("#1F2937", "#EAF0FF"),
    claude: adaptive("#C86B35", "#FFA26E"),
    gemini: adaptive("#6D6FE8", "#9EA9FF"),
    deepseek: adaptive("#1D6FD8", "#61AAFF"),
    grok: adaptive("#111827", "#F1F5FF"),
    perplexity: adaptive("#0B88A8", "#63D9FF"),

    // Glass fork: 用户换上的服务（原 Netflix / Disney+ / Prime / Claude / Perplexity 的颜色保留未用）
    emby: adaptive("#52B54B", "#6FD668"),
    instagram: adaptive("#E1306C", "#FF7AB8"),
    x: adaptive("#111827", "#FFFFFF"),
    muse: adaptive("#0082FB", "#6CB2FF"),
    doubao: adaptive("#4D6BFE", "#8AA5FF"),
    appleai: adaptive("#111827", "#FFFFFF")
  };
}

function servicePolicyCandidates(serviceId, category) {
  const id = clean(serviceId).toLowerCase();
  const type = clean(category).toLowerCase();

  const commonLMT = [
    "LMT",
    "流媒体",
    "流媒体解锁",
    "流媒体服务",
    "流媒体策略",
    "流媒体节点",
    "全球流媒体",
    "国际流媒体",
    "国外流媒体",
    "海外流媒体",
    "全球媒体",
    "国际媒体",
    "国外媒体",
    "海外媒体",
    "媒体",
    "媒体服务",
    "媒体解锁",
    "影音",
    "影音娱乐",
    "影音解锁",
    "视频",
    "视频服务",
    "视频解锁",
    "串流",
    "串流媒体",
    "串流媒體",
    "流媒體",
    "解锁",
    "解鎖",
    "国际解锁",
    "海外解锁",
    "Global Media",
    "International Media",
    "Overseas Media",
    "Media",
    "Media Unlock",
    "Unlock Media",
    "Streaming",
    "Streaming Media",
    "Streaming Unlock",
    "Global Streaming",
    "International Streaming",
    "Overseas Streaming",
    "Proxy Media",
    "Stream",
    "Video",
    "Video Streaming",
    "TV",
    "Movie",
    "Movies",
    "Entertainment",
    "NETFLIX",
    "Netflix",
    "Disney",
    "Disney+",
    "YouTube",
    "Spotify",
    "Prime",
    "Prime Video",
    "TikTok",
    "HBO",
    "Max",
    "Hulu",
    "Apple TV",
    "Apple TV+",
    "Emby",
    "Plex",
    "動畫瘋",
    "动画疯",
    "Bahamut",
    "Bilibili 港澳台",
    "哔哩哔哩港澳台",
    "港台番剧",
    "港台",
    "🎬 流媒体",
    "📺 流媒体",
    "🎥 流媒体",
    "🎞 流媒体",
    "🍿 流媒体",
    "🎬 Streaming",
    "📺 Streaming",
    "🎥 Streaming",
    "🎬 Media",
    "📺 Media",
    "🍿 Media"
  ];

  const commonAI = [
    "AI",
    "Ai",
    "ai",
    "人工智能",
    "人工智能服务",
    "AI服务",
    "AI 服务",
    "AI解锁",
    "AI 解锁",
    "AI平台",
    "AI 平台",
    "AI工具",
    "AI 工具",
    "AI策略",
    "AI 策略",
    "AI节点",
    "AI 节点",
    "AI專用",
    "AI专用",
    "AI国外",
    "AI海外",
    "全球AI",
    "国际AI",
    "国外AI",
    "海外AI",
    "AIGC",
    "AGI",
    "LLM",
    "OpenAI",
    "Open AI",
    "ChatGPT",
    "Chat GPT",
    "GPT",
    "GPT4",
    "GPT-4",
    "GPT-5",
    "Claude",
    "Anthropic",
    "Gemini",
    "Google AI",
    "Bard",
    "DeepSeek",
    "Grok",
    "xAI",
    "XAI",
    "Perplexity",
    "Copilot",
    "Microsoft Copilot",
    "Poe",
    "Notion AI",
    "Midjourney",
    "Sora",
    "Cursor",
    "AI Proxy",
    "AI Services",
    "AI Unlock",
    "AI Global",
    "Global AI",
    "International AI",
    "Overseas AI",
    "Proxy AI",
    "🤖 AI",
    "✨ AI",
    "🧠 AI",
    "🤖 人工智能",
    "✨ 人工智能",
    "🧠 人工智能"
  ];

  const serviceMap = {
    netflix: [
      "Netflix",
      "NETFLIX",
      "NetFlix",
      "NF",
      "奈飞",
      "奈飛",
      "网飞",
      "網飛",
      "Netflix 解锁",
      "Netflix 解鎖",
      "Netflix Unlock",
      "Netflix 专用",
      "Netflix 專用",
      "Netflix节点",
      "Netflix 節点",
      "NF解锁",
      "NF 解锁",
      "NF Unlock",
      "Netflix/Disney",
      "Netflix & Disney",
      "Netflix Disney",
      "奈飞节点",
      "奈飞解锁",
      "🎬 Netflix",
      "🎥 Netflix",
      "🍿 Netflix"
    ],

    disney: [
      "Disney+",
      "Disney",
      "Disney Plus",
      "DisneyPlus",
      "D+",
      "DPlus",
      "迪士尼",
      "迪士尼+",
      "Disney 解锁",
      "Disney+ 解锁",
      "Disney Unlock",
      "DisneyPlus 解锁",
      "Disney 专用",
      "Disney 專用",
      "Disney 节点",
      "Disney 節点",
      "Disney+ 节点",
      "Disney+ 節点",
      "🎬 Disney+",
      "🏰 Disney+",
      "🎥 Disney"
    ],

    emby: [
      // Glass fork: 用户分组名就是 Emby，放最前面优先匹配
      "Emby",
      "EMBY",
      "Emby Server"
    ],

    spotify: [
      // Glass fork: 用户配置里的分组名是小写 spotify（上游写 Spotify，大小写对不上匹配不到），放最前面优先匹配
      "spotify",
      "Spotify",
      "SPOTIFY",
      "声破天",
      "聲破天",
      "Spotify 解锁",
      "Spotify Unlock",
      "Spotify Premium",
      "Spotify 专用",
      "Spotify 專用",
      "Spotify 节点",
      "Spotify 節点",
      "音乐",
      "音樂",
      "Music",
      "🎵 Spotify",
      "🎧 Spotify"
    ],

    tiktok: [
      // Glass fork: 用户配置里的分组名是 Tiktok（上游写 TikTok），放最前面优先匹配
      "Tiktok",
      "TikTok",
      "Tik Tok",
      "TIKTOK",
      "TK",
      "抖音国际版",
      "抖音國際版",
      "国际抖音",
      "國際抖音",
      "TikTok 解锁",
      "TikTok Unlock",
      "TikTok 专用",
      "TikTok 專用",
      "TikTok 节点",
      "TikTok 節点",
      "🎵 TikTok",
      "🎬 TikTok"
    ],

    instagram: [
      // Glass fork: 用户分组名就是 Instagram，放最前面优先匹配
      "Instagram",
      "INSTAGRAM",
      "Ins",
      "IG"
    ],

    youtube: [
      "YouTube",
      "Youtube",
      "YOUTUBE",
      "YT",
      "油管",
      "YouTube 解锁",
      "YouTube Unlock",
      "YouTube Premium",
      "YouTube Music",
      "YT Premium",
      "YT 解锁",
      "YT Unlock",
      "Google",
      "Google YouTube",
      "谷歌",
      "谷歌服务",
      "谷歌服務",
      "Google Services",
      "Google Service",
      "🎬 YouTube",
      "📺 YouTube",
      "▶️ YouTube"
    ],

    x: [
      // Glass fork: 用户分组名就是 X，放最前面优先匹配
      "X",
      "Twitter",
      "推特"
    ],

    prime: [
      "Prime",
      "Prime Video",
      "PrimeVideo",
      "Amazon Prime",
      "Amazon Video",
      "Amazon",
      "亚马逊视频",
      "亞馬遜視頻",
      "亚马逊",
      "亞馬遜",
      "Prime 解锁",
      "Prime Unlock",
      "Prime Video 解锁",
      "Prime Video Unlock",
      "Prime 专用",
      "Prime 專用",
      "Prime 节点",
      "Prime 節点",
      "🎬 Prime",
      "📺 Prime"
    ],

    chatgpt: [
      // Glass fork: 用户配置里的分组名是 Chatgpt（上游写 ChatGPT），放最前面优先匹配
      "Chatgpt",
      "ChatGPT",
      "Chat GPT",
      "OpenAI",
      "Open AI",
      "GPT",
      "GPT4",
      "GPT-4",
      "GPT5",
      "GPT-5",
      "OpenAI 解锁",
      "ChatGPT 解锁",
      "OpenAI Unlock",
      "ChatGPT Unlock",
      "OpenAI 专用",
      "OpenAI 專用",
      "ChatGPT 专用",
      "ChatGPT 專用",
      "OpenAI 节点",
      "ChatGPT 节点",
      "🤖 ChatGPT",
      "🤖 OpenAI",
      "✨ ChatGPT"
    ],

    muse: [
      // Glass fork: 用户分组名就是 Muse（Meta AI 的分组），放最前面优先匹配
      "Muse",
      "Meta AI",
      "MetaAI"
    ],

    appleai: [
      // Glass fork: 用户分组名就是 Apple-Intelligence，放最前面优先匹配
      "Apple-Intelligence",
      "Apple Intelligence",
      "苹果 AI",
      "Apple AI"
    ],

    claude: [
      "Claude",
      "Anthropic",
      "Claude AI",
      "Claude 解锁",
      "Claude Unlock",
      "Anthropic 解锁",
      "Anthropic Unlock",
      "Claude 专用",
      "Claude 專用",
      "Claude 节点",
      "Claude 節点",
      "🤖 Claude",
      "🧠 Claude"
    ],

    gemini: [
      "Gemini",
      "Google AI",
      "Bard",
      "Google Bard",
      "Gemini 解锁",
      "Gemini Unlock",
      "Google AI 解锁",
      "Google AI Unlock",
      "Gemini 专用",
      "Gemini 專用",
      "Gemini 节点",
      "Gemini 節点",
      "Google",
      "谷歌",
      "谷歌 AI",
      "🤖 Gemini",
      "✨ Gemini"
    ],

    doubao: [
      // Glass fork: 用户要求直连，DIRECT 放最前面（Egern 内置直连策略）
      "DIRECT",
      "Doubao",
      "豆包"
    ],

    deepseek: [
      // Glass fork: 用户要求直连，DIRECT 放最前面
      "DIRECT",
      "DeepSeek",
      "Deepseek",
      "DEEPSEEK",
      "深度求索",
      "DeepSeek 解锁",
      "DeepSeek Unlock",
      "DeepSeek 专用",
      "DeepSeek 專用",
      "DeepSeek 节点",
      "DeepSeek 節点",
      "🤖 DeepSeek",
      "🧠 DeepSeek"
    ],

    grok: [
      // Glass fork: 用户要求 Grok 走 X 的分组节点，X 放最前面优先匹配
      "X",
      "Grok",
      "grok",
      "GROK",
      "xAI",
      "XAI",
      "X AI",
      "Grok 解锁",
      "Grok Unlock",
      "xAI 解锁",
      "xAI Unlock",
      "Grok 专用",
      "Grok 專用",
      "Grok 节点",
      "Grok 節点",
      "X",
      "Twitter AI",
      "🤖 Grok",
      "✨ Grok"
    ],

    perplexity: [
      "Perplexity",
      "PERPLEXITY",
      "Perplexity AI",
      "Perplexity 解锁",
      "Perplexity Unlock",
      "Perplexity 专用",
      "Perplexity 專用",
      "Perplexity 节点",
      "Perplexity 節点",
      "PPLX",
      "PPLX AI",
      "🤖 Perplexity",
      "🔎 Perplexity"
    ]
  };

  const serviceCandidates = serviceMap[id] || [];

  if (type === "ai") {
    return serviceCandidates.concat(commonAI);
  }

  return serviceCandidates.concat(commonLMT);
}

function dedupeCandidates(values) {
  const seen = {};
  const output = [];

  (values || []).forEach(function (value) {
    const raw = clean(value);
    const key = raw.toLowerCase();

    if (!raw || seen[key]) {
      return;
    }

    seen[key] = true;
    output.push(raw);
  });

  return output;
}

function getLocalNetworkName(device) {
  const wifi = (device && device.wifi) || {};
  const cellular = (device && device.cellular) || {};

  const wifiName = firstMeaningful(
    wifi.ssid,
    wifi.name,
    wifi.networkName,
    getAt(device, "network.ssid"),
    getAt(device, "wifiSSID")
  );

  if (wifiName) {
    return wifiName;
  }

  const carrierName = firstMeaningful(
    cellular.carrier,
    cellular.carrierName,
    cellular.operator,
    cellular.operatorName,
    cellular.network,
    cellular.networkName,
    cellular.provider,
    cellular.serviceProvider,

    getAt(device, "carrier"),
    getAt(device, "carrierName"),
    getAt(device, "operator"),
    getAt(device, "operatorName"),
    getAt(device, "network.carrier"),
    getAt(device, "network.carrierName"),
    getAt(device, "network.operator"),
    getAt(device, "telephony.carrier"),
    getAt(device, "telephony.carrierName"),
    getAt(device, "cellularProvider")
  );

  if (carrierName) {
    return normalizeCarrierName(carrierName);
  }

  const code = firstMeaningful(
    cellular.mccmnc,
    cellular.mccMnc,
    cellular.plmn,
    cellular.operatorCode,
    getAt(device, "network.mccmnc"),
    getAt(device, "network.plmn"),
    getAt(device, "telephony.mccmnc")
  );

  const byCode = carrierByMCCMNC(code);

  if (byCode) {
    return byCode;
  }

  const mcc = firstMeaningful(
    cellular.mcc,
    cellular.mobileCountryCode,
    getAt(device, "network.mcc"),
    getAt(device, "telephony.mobileCountryCode")
  );

  const mnc = firstMeaningful(
    cellular.mnc,
    cellular.mobileNetworkCode,
    getAt(device, "network.mnc"),
    getAt(device, "telephony.mobileNetworkCode")
  );

  const byMccMnc = carrierByMCCMNC(clean(mcc) + clean(mnc));

  if (byMccMnc) {
    return byMccMnc;
  }

  return "";
}

function firstMeaningful() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = clean(arguments[index]);

    if (isMeaningful(value)) {
      return value;
    }
  }

  return "";
}

function isMeaningful(value) {
  const v = clean(value);
  const lower = v.toLowerCase();

  if (!v) return false;
  if (v === "--") return false;
  if (v === "-") return false;
  if (v === "—") return false;
  if (lower === "null") return false;
  if (lower === "undefined") return false;
  if (lower === "unknown") return false;
  if (lower === "unknow") return false;
  if (lower === "none") return false;
  if (lower === "n/a") return false;
  if (lower === "wifi") return false;
  if (lower === "wlan") return false;
  if (lower === "5g") return false;
  if (lower === "4g") return false;
  if (lower === "lte") return false;
  if (lower === "nr") return false;

  return true;
}

function normalizeCarrierName(value) {
  const raw = clean(value);
  const lower = raw.toLowerCase();

  if (!raw) return "";

  if (
    raw.includes("中国移动") ||
    lower.includes("china mobile") ||
    lower.includes("cmcc") ||
    lower.includes("cmnet") ||
    lower.includes("cmi")
  ) {
    return "中国移动";
  }

  if (
    raw.includes("中国联通") ||
    lower.includes("china unicom") ||
    lower.includes("unicom") ||
    lower.includes("cucc")
  ) {
    return "中国联通";
  }

  if (
    raw.includes("中国电信") ||
    lower.includes("china telecom") ||
    lower.includes("chinanet") ||
    lower.includes("telecom") ||
    lower.includes("ctc")
  ) {
    return "中国电信";
  }

  if (
    raw.includes("中国广电") ||
    lower.includes("china broadnet") ||
    lower.includes("cbn") ||
    lower.includes("broadnet") ||
    lower.includes("broadcasting network")
  ) {
    return "中国广电";
  }

  return raw;
}

function carrierFromISP(value) {
  return normalizeCarrierName(value);
}

function carrierByMCCMNC(value) {
  const code = clean(value).replace(/\D/g, "");

  const mobile = [
    "46000",
    "46002",
    "46004",
    "46007",
    "46008"
  ];

  const unicom = [
    "46001",
    "46006",
    "46009"
  ];

  const telecom = [
    "46003",
    "46005",
    "46011",
    "46012"
  ];

  const broadnet = [
    "46015"
  ];

  if (mobile.includes(code)) return "中国移动";
  if (unicom.includes(code)) return "中国联通";
  if (telecom.includes(code)) return "中国电信";
  if (broadnet.includes(code)) return "中国广电";

  return "";
}

function maskIP(value) {
  const raw = clean(value);

  if (!raw || raw === "未获取" || raw === "—" || raw === "-") {
    return raw;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split(".");
    return parts[0] + "." + parts[1] + ".*.*";
  }

  if (raw.includes(".")) {
    return raw.replace(
      /(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}/g,
      "$1.$2.*.*"
    );
  }

  if (raw.includes(":")) {
    const parts = raw.split(":").filter(Boolean);
    if (parts.length >= 2) {
      return parts[0] + ":" + parts[1] + ":****:****";
    }
  }

  return raw;
}

function purityGaugeSVG(score, colors) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));

  const cx = 75;
  const cy = 85;
  const rx = 55;
  const ry = 55;

  const theta = Math.PI - Math.PI * value / 100;
  const px = cx + rx * Math.cos(theta);
  const py = cy - ry * Math.sin(theta);

  const safeTrack = svgColor(colors.track, "#D8E1EA");
  const safeLeft = svgColor(colors.left, "#22C96D");
  const safeRight = svgColor(colors.right, "#E25769");
  const safeGlow = svgColor(colors.glow, "#1AE27F");
  const safeText = svgColor(colors.text, "#22C96D");
  const safeMuted = svgColor(colors.muted, "#74839A");

  const leftDash =
    value >= 99.9
      ? "100 0"
      : Math.max(0.1, value).toFixed(1) + " 100";

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="112" viewBox="0 0 150 112">',
    "<defs>",
    '<filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">',
    '<feGaussianBlur stdDeviation="2.1" result="blur"/>',
    "<feMerge>",
    '<feMergeNode in="blur"/>',
    '<feMergeNode in="SourceGraphic"/>',
    "</feMerge>",
    "</filter>",
    "</defs>",
    '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeTrack + '" stroke-width="9" stroke-linecap="round" opacity="0.75"/>',
    '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeRight + '" stroke-width="8.2" stroke-linecap="round" opacity="0.95"/>',
    '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeGlow + '" stroke-width="13" stroke-linecap="round" pathLength="100" stroke-dasharray="' + leftDash + '" opacity="0.16"/>',
    '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeLeft + '" stroke-width="8.4" stroke-linecap="round" pathLength="100" stroke-dasharray="' + leftDash + '" opacity="1"/>',
    '<circle cx="' + px.toFixed(2) + '" cy="' + py.toFixed(2) + '" r="6.5" fill="' + safeGlow + '" opacity="0.20"/>',
    '<circle cx="' + px.toFixed(2) + '" cy="' + py.toFixed(2) + '" r="4.2" fill="' + safeLeft + '" filter="url(#softGlow)" opacity="1"/>',
    '<text x="75" y="61" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="30" font-weight="850" fill="' + safeText + '">' + Math.round(value) + "</text>",
    '<text x="75" y="75" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="10" font-weight="760" fill="' + safeMuted + '">/100</text>',
    '<text x="75" y="90" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="10" font-weight="760" fill="' + safeMuted + '">纯净评分</text>',
    "</svg>"
  ].join("");
}

function svgDataURI(svg) {
  return "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(svg)
      .replace(/'/g, "%27")
      .replace(/"/g, "%22");
}

function svgColor(value, fallback) {
  const color = clean(value);
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  if (/^#[0-9a-fA-F]{3}$/.test(color)) return color;
  return fallback;
}

function getCurrentProxyInfo(ctx) {
  const proxyName = clean(
    pick(
      getAt(ctx, "node.name"),
      getAt(ctx, "proxy.name"),
      getAt(ctx, "currentProxy.name"),
      getAt(ctx, "selectedProxy.name"),
      getAt(ctx, "selectedNode.name"),
      getAt(ctx, "policy.node.name"),
      getAt(ctx, "policy.selected.name"),
      getAt(ctx, "policy.current.name"),
      getAt(ctx, "outbound.name"),
      getAt(ctx, "profile.currentNode.name"),
      getAt(ctx, "profile.selectedNode.name"),
      findProxyNameInObject(ctx)
    )
  );

  const rawProtocol = clean(
    pick(
      getAt(ctx, "node.protocol"),
      getAt(ctx, "node.type"),
      getAt(ctx, "node.scheme"),
      getAt(ctx, "proxy.protocol"),
      getAt(ctx, "proxy.type"),
      getAt(ctx, "proxy.scheme"),
      getAt(ctx, "currentProxy.protocol"),
      getAt(ctx, "currentProxy.type"),
      getAt(ctx, "currentProxy.scheme"),
      getAt(ctx, "selectedProxy.protocol"),
      getAt(ctx, "selectedProxy.type"),
      getAt(ctx, "selectedProxy.scheme"),
      getAt(ctx, "selectedNode.protocol"),
      getAt(ctx, "selectedNode.type"),
      getAt(ctx, "selectedNode.scheme"),
      getAt(ctx, "policy.node.protocol"),
      getAt(ctx, "policy.node.type"),
      getAt(ctx, "policy.selected.protocol"),
      getAt(ctx, "policy.selected.type"),
      getAt(ctx, "policy.current.protocol"),
      getAt(ctx, "policy.current.type"),
      getAt(ctx, "outbound.protocol"),
      getAt(ctx, "outbound.type"),
      getAt(ctx, "outbound.scheme"),
      getAt(ctx, "profile.currentNode.protocol"),
      getAt(ctx, "profile.currentNode.type"),
      getAt(ctx, "profile.selectedNode.protocol"),
      getAt(ctx, "profile.selectedNode.type"),
      findProtocolInObject(ctx)
    )
  );

  const protocol =
    normalizeProxyProtocol(rawProtocol) ||
    normalizeProxyProtocol(proxyName);

  return {
    name: proxyName,
    protocol: protocol
  };
}

function findProtocolInObject(object) {
  const found = [];
  const seen = [];

  function walk(value, path, depth) {
    if (depth > 5) return;
    if (!value || typeof value !== "object") return;
    if (seen.indexOf(value) >= 0) return;

    seen.push(value);

    Object.keys(value).forEach(function (key) {
      const next = value[key];
      const nextPath = path ? path + "." + key : key;
      const lowerPath = nextPath.toLowerCase();

      if (typeof next === "string") {
        const protocol = normalizeProxyProtocol(next);

        if (
          protocol &&
          (
            lowerPath.includes("proxy") ||
            lowerPath.includes("node") ||
            lowerPath.includes("outbound") ||
            lowerPath.includes("policy") ||
            lowerPath.includes("protocol") ||
            lowerPath.includes("scheme")
          )
        ) {
          found.push(protocol);
        }
      } else if (next && typeof next === "object") {
        walk(next, nextPath, depth + 1);
      }
    });
  }

  walk(object, "", 0);

  return found[0] || "";
}

function findProxyNameInObject(object) {
  const found = [];
  const seen = [];

  function walk(value, path, depth) {
    if (depth > 5) return;
    if (!value || typeof value !== "object") return;
    if (seen.indexOf(value) >= 0) return;

    seen.push(value);

    Object.keys(value).forEach(function (key) {
      const next = value[key];
      const nextPath = path ? path + "." + key : key;
      const lowerPath = nextPath.toLowerCase();

      if (typeof next === "string") {
        if (
          isMeaningful(next) &&
          (
            lowerPath.includes("proxy") ||
            lowerPath.includes("node") ||
            lowerPath.includes("outbound") ||
            lowerPath.includes("policy")
          ) &&
          (
            lowerPath.includes("name") ||
            lowerPath.includes("title")
          )
        ) {
          found.push(next);
        }
      } else if (next && typeof next === "object") {
        walk(next, nextPath, depth + 1);
      }
    });
  }

  walk(object, "", 0);

  return found[0] || "";
}

function protocolFromXY(value) {
  const raw = clean(value);

  if (!raw) {
    return "";
  }

  return normalizeProxyProtocol(raw) || raw;
}

function normalizeProxyProtocol(value) {
  const raw = clean(value);
  const text = raw.toLowerCase();

  if (!text) {
    return "";
  }

  const normalized = text
    .replace(/[_\-]+/g, " ")
    .replace(/[()[\]{}|,;]+/g, " ");

  const checks = [
    [/vless/, "VLESS"],
    [/vmess/, "VMESS"],
    [/trojan/, "Trojan"],
    [/shadowsocks\s*r|ssr/, "SSR"],
    [/shadowsocks|(^|\s)ss($|\s)/, "SS"],
    [/hysteria\s*2|hy2/, "HY2"],
    [/hysteria/, "Hysteria"],
    [/tuic/, "TUIC"],
    [/snell/, "Snell"],
    [/any\s*tls|anytls/, "AnyTLS"],
    [/wireguard|(^|\s)wg($|\s)/, "WireGuard"],
    [/socks\s*5|socks5/, "SOCKS5"],
    [/socks/, "SOCKS"],
    [/http\s*2|h2/, "HTTP/2"],
    [/https/, "HTTPS"],
    [/http/, "HTTP"],
    [/ssh/, "SSH"],
    [/mieru/, "Mieru"],
    [/juicity/, "Juicity"],
    [/shadow\s*tls|shadowtls/, "ShadowTLS"],
    [/naive/, "Naive"],
    [/brook/, "Brook"]
  ];

  for (let index = 0; index < checks.length; index += 1) {
    if (checks[index][0].test(normalized)) {
      return checks[index][1];
    }
  }

  return "";
}

function parseExitSource(data, sourceName) {
  if (!data || typeof data !== "object") {
    return {};
  }

  const ip = clean(
    pick(
      data.ip,
      data.query,
      data.ip_address,
      getAt(data, "location.ip")
    )
  );

  if (!ip) {
    return {};
  }

  const isp = clean(
    pick(
      getAt(data, "company.name"),
      getAt(data, "connection.isp"),
      getAt(data, "connection.org"),
      getAt(data, "asn.name"),
      data.isp,
      data.org,
      data.organization,
      data.asname,
      data.as,
      "未知组织"
    )
  );

  const orgText = [
    isp,
    data.org,
    data.organization,
    data.as,
    data.asname,
    getAt(data, "company.name"),
    getAt(data, "asn.name"),
    getAt(data, "connection.org"),
    getAt(data, "connection.isp")
  ].join(" ");

  const cloud = cloudProviderFromText(orgText);

  const flags = {
    datacenter:
      truthy(
        pick(
          data.is_datacenter,
          data.hosting,
          getAt(data, "security.is_datacenter"),
          getAt(data, "company.is_datacenter")
        )
      ) || cloud.hit,

    hosting:
      truthy(
        pick(
          data.hosting,
          data.is_hosting,
          getAt(data, "security.is_hosting")
        )
      ) || cloud.hit,

    cloud: cloud.hit,

    proxy: truthy(
      pick(
        data.proxy,
        data.is_proxy,
        getAt(data, "security.is_proxy"),
        getAt(data, "security.proxy")
      )
    ),

    vpn: truthy(
      pick(
        data.is_vpn,
        getAt(data, "security.is_vpn"),
        getAt(data, "security.vpn")
      )
    ),

    tor: truthy(
      pick(
        data.is_tor,
        getAt(data, "security.is_tor"),
        getAt(data, "security.tor")
      )
    ),

    abuser: truthy(
      pick(
        data.is_abuser,
        getAt(data, "security.is_abuser")
      )
    ),

    mobile: truthy(
      pick(
        data.mobile,
        data.is_mobile,
        getAt(data, "connection.mobile")
      )
    ),

    residential: false,

    risk: numberOrNull(
      pick(
        data.risk,
        getAt(data, "security.risk"),
        getAt(data, "risk.score")
      )
    )
  };

  const rawType = clean(
    pick(
      getAt(data, "company.type"),
      getAt(data, "connection.type"),
      getAt(data, "asn.type")
    )
  ).toLowerCase();

  if (
    rawType.includes("isp") ||
    rawType.includes("residential") ||
    rawType.includes("broadband")
  ) {
    flags.residential = true;
  }

  if (
    rawType.includes("hosting") ||
    rawType.includes("datacenter") ||
    rawType.includes("cloud")
  ) {
    flags.datacenter = true;
    flags.hosting = true;
  }

  const rawCountry = clean(
    pick(
      getAt(data, "location.country"),
      data.country_name,
      data.country
    )
  );

  return {
    source: sourceName || "",
    ip: ip,
    city: clean(
      pick(
        getAt(data, "location.city"),
        data.city,
        getAt(data, "location.region"),
        data.regionName,
        data.region,
        "未知城市"
      )
    ),
    region: clean(
      pick(
        getAt(data, "location.region"),
        data.regionName,
        data.region
      )
    ),
    country:
      rawCountry.length === 2
        ? ""
        : rawCountry,
    countryCode: countryCode(
      pick(
        getAt(data, "location.country_code"),
        data.country_code,
        data.countryCode,
        rawCountry.length === 2 ? rawCountry : ""
      )
    ),
    isp: cloud.name || isp,
    cloudProvider: cloud.name,
    kind: classifyExitKind(flags),
    flags: flags
  };
}

function parseProxyCheck(data, ip) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const target = clean(ip);
  const keys = Object.keys(data);
  const fallbackKey = keys.find(function (key) {
    return key !== "status" && key !== "message";
  });

  const item = data[target] || data[fallbackKey];

  if (!item || typeof item !== "object") {
    return null;
  }

  const typeText = clean(
    pick(
      item.type,
      item.proxy,
      item.provider,
      item.organisation,
      item.asn,
      item.operator
    )
  );

  const orgText = [
    item.provider,
    item.organisation,
    item.operator,
    item.asn,
    item.type
  ].join(" ");

  const cloud = cloudProviderFromText(orgText);

  const proxyValue = clean(item.proxy).toLowerCase();
  const typeLower = typeText.toLowerCase();

  const flags = {
    datacenter:
      cloud.hit ||
      typeLower.includes("hosting") ||
      typeLower.includes("server") ||
      typeLower.includes("business"),

    hosting:
      cloud.hit ||
      typeLower.includes("hosting") ||
      typeLower.includes("server"),

    cloud: cloud.hit,

    proxy:
      proxyValue === "yes" ||
      typeLower.includes("proxy"),

    vpn:
      typeLower.includes("vpn"),

    tor:
      typeLower.includes("tor"),

    abuser:
      typeLower.includes("abuse") ||
      typeLower.includes("blacklist") ||
      typeLower.includes("spam"),

    mobile:
      typeLower.includes("mobile"),

    residential:
      typeLower.includes("residential"),

    risk:
      numberOrNull(item.risk)
  };

  return {
    source: "proxycheck.io",
    ip: target,
    city: clean(item.city),
    region: clean(item.region),
    country: clean(item.country),
    countryCode: countryCode(item.isocode),
    isp: clean(
      pick(
        cloud.name,
        item.provider,
        item.organisation,
        item.operator,
        "未知组织"
      )
    ),
    cloudProvider: cloud.name,
    kind: classifyExitKind(flags),
    flags: flags
  };
}

function mergeExitSources(sources) {
  const valid = (sources || []).filter(function (item) {
    return item && item.ip;
  });

  if (valid.length === 0) {
    return {
      ip: "未识别",
      city: "出口检测失败",
      region: "",
      country: "",
      countryCode: "",
      isp: "未知组织",
      kind: "未知网络",
      flags: {}
    };
  }

  const primaryIP =
    mostCommon(
      valid.map(function (item) {
        return item.ip;
      })
    ) || valid[0].ip;

  const sameIP = valid.filter(function (item) {
    return item.ip === primaryIP;
  });

  const allText = sameIP
    .map(function (item) {
      return [
        item.isp,
        item.cloudProvider,
        item.country,
        item.city,
        item.region
      ].join(" ");
    })
    .join(" ");

  const cloud = cloudProviderFromText(allText);

  const evidence = {
    sourceCount: sameIP.length,
    datacenterCount: 0,
    hostingCount: 0,
    cloudCount: cloud.hit ? 1 : 0,
    proxyCount: 0,
    vpnCount: 0,
    torCount: 0,
    abuserCount: 0,
    mobileCount: 0,
    residentialCount: 0,
    riskMax: null,
    riskCount: 0
  };

  sameIP.forEach(function (item) {
    const flags = item.flags || {};

    if (flags.datacenter) evidence.datacenterCount += 1;
    if (flags.hosting) evidence.hostingCount += 1;
    if (flags.cloud) evidence.cloudCount += 1;
    if (flags.proxy) evidence.proxyCount += 1;
    if (flags.vpn) evidence.vpnCount += 1;
    if (flags.tor) evidence.torCount += 1;
    if (flags.abuser) evidence.abuserCount += 1;
    if (flags.mobile) evidence.mobileCount += 1;
    if (flags.residential) evidence.residentialCount += 1;

    if (Number.isFinite(Number(flags.risk))) {
      evidence.riskCount += 1;
      evidence.riskMax = Math.max(
        Number(evidence.riskMax || 0),
        Number(flags.risk)
      );
    }
  });

  const mergedFlags = {
    datacenter: evidence.datacenterCount > 0,
    hosting: evidence.hostingCount > 0,
    cloud: evidence.cloudCount > 0,
    proxy: evidence.proxyCount > 0,
    vpn: evidence.vpnCount > 0,
    tor: evidence.torCount > 0,
    abuser: evidence.abuserCount > 0,
    mobile: evidence.mobileCount > 0,
    residential: evidence.residentialCount > 0,
    risk: evidence.riskMax,
    evidence: evidence
  };

  if (cloud.hit) {
    mergedFlags.datacenter = true;
    mergedFlags.hosting = true;
    mergedFlags.cloud = true;
    mergedFlags.residential = false;
  }

  const kind = classifyExitKind(mergedFlags);

  return {
    ip: primaryIP,
    city: bestField(sameIP, "city") || "未知城市",
    region: bestField(sameIP, "region"),
    country: bestField(sameIP, "country"),
    countryCode: countryCode(bestField(sameIP, "countryCode")),
    isp: cloud.name || bestField(sameIP, "isp") || "未知组织",
    cloudProvider: cloud.name,
    kind: kind,
    flags: mergedFlags,
    sources: sameIP
      .map(function (item) {
        return item.source;
      })
      .filter(Boolean)
  };
}

function classifyExitKind(flags) {
  const f = flags || {};

  if (f.mobile) {
    return "移动网络";
  }

  if (f.residential) {
    return "住宅 IP";
  }

  if (f.datacenter || f.hosting || f.cloud) {
    return "商业机房";
  }

  if (f.proxy || f.vpn) {
    return "住宅 IP";
  }

  return "未知网络";
}

function cloudProviderFromText(value) {
  const text = clean(value).toLowerCase();

  if (!text) {
    return {
      hit: false,
      name: ""
    };
  }

  const providers = [
    ["oracle", "Oracle"],
    ["oci", "Oracle"],
    ["amazon", "AWS"],
    ["aws", "AWS"],
    ["google cloud", "Google Cloud"],
    ["google llc", "Google"],
    ["microsoft", "Microsoft Azure"],
    ["azure", "Microsoft Azure"],
    ["digitalocean", "DigitalOcean"],
    ["vultr", "Vultr"],
    ["linode", "Akamai Linode"],
    ["akamai", "Akamai"],
    ["ovh", "OVH"],
    ["hetzner", "Hetzner"],
    ["leaseweb", "Leaseweb"],
    ["m247", "M247"],
    ["choopa", "Vultr"],
    ["contabo", "Contabo"],
    ["scaleway", "Scaleway"],
    ["hivelocity", "Hivelocity"],
    ["cloudflare", "Cloudflare"],
    ["tencent cloud", "Tencent Cloud"],
    ["alibaba cloud", "Alibaba Cloud"],
    ["aliyun", "Alibaba Cloud"],
    ["alicloud", "Alibaba Cloud"],
    ["huawei cloud", "Huawei Cloud"],
    ["volcengine", "Volcengine"],
    ["ucloud", "UCLOUD"],
    ["uccloud", "UCLOUD"]
  ];

  for (let index = 0; index < providers.length; index += 1) {
    if (text.includes(providers[index][0])) {
      return {
        hit: true,
        name: providers[index][1]
      };
    }
  }

  return {
    hit: false,
    name: ""
  };
}

function mostCommon(values) {
  const count = {};
  let best = "";
  let bestCount = 0;

  values
    .map(clean)
    .filter(Boolean)
    .forEach(function (value) {
      count[value] = (count[value] || 0) + 1;

      if (count[value] > bestCount) {
        best = value;
        bestCount = count[value];
      }
    });

  return best;
}

function bestField(items, field) {
  const values = (items || [])
    .map(function (item) {
      return clean(item[field]);
    })
    .filter(Boolean);

  return mostCommon(values) || values[0] || "";
}

function numberOrNull(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function parseLocalExit(data, forceLocalMainland) {
  if (!data || typeof data !== "object") {
    return {};
  }

  const ip = clean(
    pick(
      data.query,
      data.ip,
      data.ip_address,
      getAt(data, "location.ip")
    )
  );

  if (!ip) {
    return {};
  }

  const countryCodeValue = countryCode(
    pick(
      data.countryCode,
      data.country_code,
      getAt(data, "location.country_code")
    )
  );

  const country = clean(
    pick(
      data.country,
      data.country_name,
      getAt(data, "location.country")
    )
  );

  const region = clean(
    pick(
      data.regionName,
      data.region,
      getAt(data, "location.region")
    )
  );

  const city = clean(
    pick(
      data.city,
      getAt(data, "location.city")
    )
  );

  const isChina =
    countryCodeValue === "CN" ||
    country.includes("中国") ||
    forceLocalMainland;

  const label = isChina
    ? mainlandAreaLabel(region, city)
    : formatLocalArea(countryCodeValue, country, region, city);

  return {
    ip: ip,
    country: isChina ? "中国" : country,
    countryCode: isChina ? "CN" : countryCodeValue,
    region: region,
    city: city,
    isp: clean(pick(data.isp, data.org, data.organization)),
    org: clean(data.org),
    asname: clean(data.asname),
    as: clean(data.as),
    label: label
  };
}

function mainlandAreaLabel(region, city) {
  const label = formatLocalArea("CN", "中国", region, city);

  if (!label || label === "中国") {
    return "中国大陆";
  }

  return label;
}

function formatLocalArea(countryCodeValue, country, region, city) {
  const cc = countryCode(countryCodeValue);
  let r = clean(region);
  let c = clean(city);

  r = r
    .replace(/省$/g, "")
    .replace(/市$/g, "")
    .replace(/壮族自治区$/g, "")
    .replace(/回族自治区$/g, "")
    .replace(/维吾尔自治区$/g, "")
    .replace(/自治区$/g, "");

  c = c.replace(/市$/g, "");

  if (cc === "CN" || country.includes("中国")) {
    if (["北京", "上海", "天津", "重庆"].includes(r)) {
      return r;
    }

    if (r && c && r !== c) {
      return r + c;
    }

    return c || r || "中国";
  }

  if (c && r && c !== r) {
    return r + " " + c;
  }

  return c || r || country || "直连地区未知";
}

function providerFromText(value) {
  const text = clean(value).toLowerCase();

  if (!text) {
    return { full: "", short: "" };
  }

  if (text.includes("cloudflare")) return { full: "Cloudflare DNS", short: "CF" };
  if (text.includes("google")) return { full: "Google DNS", short: "谷歌" };
  if (text.includes("quad9")) return { full: "Quad9 DNS", short: "Q9" };
  if (text.includes("opendns") || text.includes("cisco")) return { full: "OpenDNS", short: "Open" };
  if (text.includes("adguard")) return { full: "AdGuard DNS", short: "AdG" };
  if (text.includes("nextdns")) return { full: "NextDNS", short: "Next" };
  if (text.includes("cleanbrowsing")) return { full: "CleanBrowsing DNS", short: "Clean" };
  if (text.includes("dns.sb")) return { full: "DNS.SB", short: "DNS.SB" };
  if (text.includes("mullvad")) return { full: "Mullvad DNS", short: "Mull" };
  if (text.includes("control d") || text.includes("controld")) return { full: "Control D DNS", short: "CtrlD" };

  if (
    text.includes("alidns") ||
    text.includes("alibaba") ||
    text.includes("aliyun") ||
    text.includes("alicloud") ||
    text.includes("alibaba cloud")
  ) {
    return { full: "AliDNS", short: "阿里" };
  }

  if (
    text.includes("dnspod") ||
    text.includes("tencent") ||
    text.includes("tencent cloud")
  ) {
    return { full: "DNSPod", short: "腾讯" };
  }

  if (
    text.includes("baidu") ||
    text.includes("baidudns")
  ) {
    return { full: "Baidu DNS", short: "百度" };
  }

  if (
    text.includes("360") ||
    text.includes("qihoo")
  ) {
    return { full: "360 DNS", short: "360" };
  }

  if (
    text.includes("114dns") ||
    text.includes("114 dns") ||
    text.includes("114.114")
  ) {
    return { full: "114DNS", short: "114" };
  }

  if (
    text.includes("chinanet") ||
    text.includes("china telecom") ||
    text.includes("telecom") ||
    text.includes("ctc") ||
    text.includes("中国电信") ||
    text.includes("电信")
  ) {
    return { full: "中国电信 DNS", short: "电信" };
  }

  if (
    text.includes("china mobile") ||
    text.includes("cmcc") ||
    text.includes("cmnet") ||
    text.includes("cmi") ||
    text.includes("中国移动") ||
    text.includes("移动")
  ) {
    return { full: "中国移动 DNS", short: "移动" };
  }

  if (
    text.includes("china unicom") ||
    text.includes("unicom") ||
    text.includes("cucc") ||
    text.includes("中国联通") ||
    text.includes("联通")
  ) {
    return { full: "中国联通 DNS", short: "联通" };
  }

  if (
    text.includes("cernet") ||
    text.includes("china education") ||
    text.includes("education network") ||
    text.includes("中国教育") ||
    text.includes("教育网")
  ) {
    return { full: "中国教育网 DNS", short: "教育" };
  }

  if (
    text.includes("great wall broadband") ||
    text.includes("gwbn") ||
    text.includes("长城宽带")
  ) {
    return { full: "长城宽带 DNS", short: "长宽" };
  }

  if (
    text.includes("drpeng") ||
    text.includes("鹏博士")
  ) {
    return { full: "鹏博士 DNS", short: "鹏博" };
  }

  return { full: "", short: "" };
}

function compactDNSProviderName(value) {
  const text = clean(value);

  if (!text) {
    return "未知";
  }

  const provider = providerFromText(text);

  if (provider.short) {
    return provider.short;
  }

  const lower = text.toLowerCase();

  if (lower.includes("telecom")) return "电信";
  if (lower.includes("mobile")) return "移动";
  if (lower.includes("unicom")) return "联通";
  if (lower.includes("education")) return "教育";
  if (lower.includes("cloudflare")) return "CF";
  if (lower.includes("google")) return "谷歌";
  if (lower.includes("oracle")) return "Oracle";
  if (lower.includes("amazon") || lower.includes("aws")) return "AWS";
  if (lower.includes("microsoft") || lower.includes("azure")) return "Azure";

  const cleaned = text
    .replace(/^as\d+\s*/i, "")
    .replace(/co\.,?\s*ltd\.?/ig, "")
    .replace(/company/ig, "")
    .replace(/limited/ig, "")
    .replace(/inc\.?/ig, "")
    .replace(/llc/ig, "")
    .replace(/corporation/ig, "")
    .replace(/network/ig, "")
    .replace(/communications?/ig, "")
    .replace(/internet/ig, "")
    .replace(/technology/ig, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "未知";
  }

  if (/[\u4e00-\u9fa5]/.test(cleaned)) {
    return cleaned.slice(0, 4);
  }

  const first = cleaned.split(/[ ,，/|()]+/).filter(Boolean)[0];

  if (!first) {
    return "未知";
  }

  return first.length > 6
    ? first.slice(0, 6)
    : first;
}

function chooseDNSProvider(baseDNS, verifiedDNS) {
  const base = baseDNS || {
    full: "",
    short: ""
  };

  const verified = verifiedDNS || {
    ok: false,
    full: "",
    short: "",
    ip: "",
    geo: "",
    isp: "",
    org: "",
    asname: "",
    as: ""
  };

  const verifiedProvider = providerFromText(
    [
      verified.full,
      verified.short,
      verified.geo,
      verified.ip,
      verified.isp,
      verified.org,
      verified.asname,
      verified.as
    ].join(" ")
  );

  if (verifiedProvider.short) {
    return verifiedProvider;
  }

  if (verified.ok && verified.short && !isWeakDNSLabel(verified.short)) {
    return {
      full: verified.full || verified.short,
      short: dnsTinyLabel(verified.short)
    };
  }

  const baseProvider = providerFromText(
    [
      base.full,
      base.short
    ].join(" ")
  );

  if (baseProvider.short) {
    return baseProvider;
  }

  if (base.short && !isWeakDNSLabel(base.short)) {
    return {
      full: base.full,
      short: dnsTinyLabel(base.short)
    };
  }

  if (verified.ok && verified.ip) {
    return {
      full: verified.ip,
      short: compactDNSProviderName(
        verified.isp ||
        verified.org ||
        verified.asname ||
        verified.as ||
        verified.geo ||
        verified.ip
      )
    };
  }

  return {
    full: "未知 DNS",
    short: "未知"
  };
}

function isWeakDNSLabel(value) {
  return [
    "",
    "系统",
    "网关",
    "自定义",
    "自定",
    "未知",
    "IPv6"
  ].includes(clean(value));
}

function dnsTinyLabel(value) {
  const name = clean(value);
  const provider = providerFromText(name);

  if (provider.short) {
    return provider.short;
  }

  const map = {
    "Cloudflare": "CF",
    "Cloudflare DNS": "CF",
    "CF": "CF",
    "Google": "谷歌",
    "Google DNS": "谷歌",
    "谷歌": "谷歌",
    "AliDNS": "阿里",
    "Ali": "阿里",
    "阿里": "阿里",
    "DNSPod": "腾讯",
    "Pod": "腾讯",
    "腾讯": "腾讯",
    "OpenDNS": "Open",
    "Open": "Open",
    "AdGuard": "AdG",
    "AdG": "AdG",
    "Quad9": "Q9",
    "Q9": "Q9",
    "114DNS": "114",
    "114": "114",
    "NextDNS": "Next",
    "Next": "Next",
    "中国电信 DNS": "电信",
    "电信": "电信",
    "中国移动 DNS": "移动",
    "移动": "移动",
    "中国联通 DNS": "联通",
    "联通": "联通",
    "中国教育网 DNS": "教育",
    "教育": "教育",
    "网关 DNS": "网关",
    "网关": "网关",
    "系统": "系统",
    "自定义": "自定",
    "自定": "自定",
    "未知": "未知",
    "IPv6": "IPv6"
  };

  if (map[name]) {
    return map[name];
  }

  if (name.length <= 4) {
    return name;
  }

  return "未知";
}

function purityScore(exit) {
  const flags = (exit && exit.flags) || {};
  const evidence = flags.evidence || {};
  const kind = clean(exit && exit.kind);

  let score;

  if (kind === "住宅 IP") {
    score = 92;
  } else if (kind === "移动网络") {
    score = 92;
  } else if (kind === "教育网络" || kind === "企业网络") {
    score = 88;
  } else if (kind === "商业机房") {
    score = 78;
  } else {
    score = 72;
  }

  const proxyCount = Number(evidence.proxyCount || 0);
  const vpnCount = Number(evidence.vpnCount || 0);
  const torCount = Number(evidence.torCount || 0);
  const abuserCount = Number(evidence.abuserCount || 0);
  const riskValue = Number(flags.risk);

  const proxyVpnEvidenceCount = proxyCount + vpnCount;

  if (torCount > 0 || flags.tor) {
    score -= 55;
  }

  if (abuserCount > 0 || flags.abuser) {
    score -= 35;
  }

  if (proxyVpnEvidenceCount >= 2) {
    score -= 30;
  } else if (proxyVpnEvidenceCount === 1) {
    score -= 16;
  }

  if (Number.isFinite(riskValue)) {
    if (riskValue >= 80) {
      score -= 25;
    } else if (riskValue >= 70) {
      score -= 20;
    } else if (riskValue >= 40) {
      score -= 10;
    } else if (riskValue >= 20) {
      score -= 4;
    }
  }

  if (kind === "商业机房" || flags.datacenter || flags.hosting || flags.cloud) {
    score -= 8;
  }

  if (
    kind === "住宅 IP" &&
    !flags.proxy &&
    !flags.vpn &&
    !flags.tor &&
    !flags.abuser
  ) {
    score += 3;
  }

  if (
    kind === "移动网络" &&
    !flags.proxy &&
    !flags.vpn &&
    !flags.tor &&
    !flags.abuser
  ) {
    score += 3;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score: score,
    risk: 100 - score,
    evidence: evidence
  };
}

function riskLevel(exit, purity) {
  const flags = (exit && exit.flags) || {};
  const evidence = flags.evidence || {};
  const score = Number(purity && purity.score);
  const riskValue = Number(flags.risk);

  const proxyVpnEvidenceCount =
    Number(evidence.proxyCount || 0) +
    Number(evidence.vpnCount || 0);

  if (
    flags.tor ||
    Number(evidence.torCount || 0) > 0 ||
    flags.abuser ||
    Number(evidence.abuserCount || 0) > 0 ||
    riskValue >= 85 ||
    score < 45 ||
    (
      proxyVpnEvidenceCount >= 2 &&
      (
        score < 60 ||
        riskValue >= 70
      )
    )
  ) {
    return "高风险";
  }

  if (
    score < 75 ||
    flags.datacenter ||
    flags.hosting ||
    flags.cloud ||
    proxyVpnEvidenceCount > 0 ||
    riskValue >= 40
  ) {
    return "中风险";
  }

  return "低风险";
}

function toneColor(tone, colors) {
  if (tone === "green") return colors.green;
  if (tone === "red") return colors.red;
  return colors.amber;
}

function parseIPv4(ip) {
  const parts = clean(ip).split(".");
  if (parts.length !== 4) return null;

  const values = parts.map(Number);

  if (
    values.some(function (value) {
      return !Number.isInteger(value) || value < 0 || value > 255;
    })
  ) {
    return null;
  }

  return values;
}

function isPrivateIPv4(ip) {
  const parts = parseIPv4(ip);
  if (!parts) return false;

  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isCGNATIPv4(ip) {
  const parts = parseIPv4(ip);
  return Boolean(
    parts &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127
  );
}

function isPublicIPv4(ip) {
  const parts = parseIPv4(ip);

  return Boolean(
    parts &&
    !isPrivateIPv4(ip) &&
    !isCGNATIPv4(ip) &&
    parts[0] !== 0 &&
    parts[0] !== 127 &&
    parts[0] < 224 &&
    !(parts[0] === 169 && parts[1] === 254)
  );
}

function detectNAT(localIP, exitIP) {
  if (isCGNATIPv4(localIP)) {
    return {
      label: "CGNAT",
      tone: "amber"
    };
  }

  if (
    isPrivateIPv4(localIP) &&
    isPublicIPv4(exitIP)
  ) {
    return {
      label: "Open",
      tone: "green"
    };
  }

  if (isPublicIPv4(localIP)) {
    return {
      label: "Open",
      tone: "green"
    };
  }

  if (isPrivateIPv4(localIP)) {
    return {
      label: "NAT",
      tone: "amber"
    };
  }

  return {
    label: "未知",
    tone: "red"
  };
}

function detectDNSProvider(addresses) {
  const list = Array.isArray(addresses)
    ? addresses.map(clean).filter(Boolean)
    : [clean(addresses)].filter(Boolean);

  if (list.length === 0) {
    return {
      full: "系统 DNS",
      short: "系统"
    };
  }

  const providers = [
    {
      full: "Cloudflare DNS",
      short: "CF",
      values: [
        "1.1.1.1",
        "1.0.0.1",
        "2606:4700:4700::1111",
        "2606:4700:4700::1001",
        "2606:4700:4700::64",
        "2606:4700:4700::6400"
      ]
    },
    {
      full: "Google DNS",
      short: "谷歌",
      values: [
        "8.8.8.8",
        "8.8.4.4",
        "2001:4860:4860::8888",
        "2001:4860:4860::8844"
      ]
    },
    {
      full: "Quad9 DNS",
      short: "Q9",
      values: [
        "9.9.9.9",
        "149.112.112.112",
        "2620:fe::fe",
        "2620:fe::9"
      ]
    },
    {
      full: "OpenDNS",
      short: "Open",
      values: [
        "208.67.222.222",
        "208.67.220.220",
        "2620:119:35::35",
        "2620:119:53::53"
      ]
    },
    {
      full: "AdGuard DNS",
      short: "AdG",
      values: [
        "94.140.14.14",
        "94.140.15.15",
        "94.140.14.15",
        "94.140.15.16",
        "2a10:50c0::ad1:ff",
        "2a10:50c0::ad2:ff"
      ]
    },
    {
      full: "AliDNS",
      short: "阿里",
      values: [
        "223.5.5.5",
        "223.6.6.6",
        "2400:3200::1",
        "2400:3200:baba::1"
      ]
    },
    {
      full: "DNSPod",
      short: "腾讯",
      values: [
        "119.29.29.29",
        "119.28.28.28",
        "2402:4e00::"
      ]
    },
    {
      full: "114DNS",
      short: "114",
      values: [
        "114.114.114.114",
        "114.114.115.115",
        "240c::6666",
        "240c::6644"
      ]
    },
    {
      full: "NextDNS",
      short: "Next",
      values: [
        "45.90.28.",
        "45.90.30.",
        "2a07:a8c0:"
      ]
    }
  ];

  for (let i = 0; i < list.length; i += 1) {
    const raw = normalizeDNS(list[i]);

    for (let p = 0; p < providers.length; p += 1) {
      const provider = providers[p];

      for (let v = 0; v < provider.values.length; v += 1) {
        const value = provider.values[v].toLowerCase();

        if (raw === value || raw.startsWith(value)) {
          return provider;
        }
      }
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const raw = normalizeDNS(list[i]);

    if (
      raw.startsWith("fe80:") ||
      isPrivateIPv4(raw)
    ) {
      return {
        full: "本地网关 DNS",
        short: "网关"
      };
    }
  }

  return {
    full: "自定义 DNS",
    short: "自定义"
  };
}

function normalizeDNS(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/%.*$/, "");
}

function gatewayLabel(value) {
  const gateway = clean(value);
  if (!gateway || gateway === "未获取") return "—";
  return gateway;
}

function shortISP(value) {
  const isp = clean(value);

  if (!isp || isp === "未知组织") {
    return "未知";
  }

  if (isp.length <= 12) {
    return isp;
  }

  const words = isp.split(/\s+/);

  if (words.length > 1) {
    return words[0];
  }

  return isp.slice(0, 11) + "…";
}

function randomAlphaNum(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";

  for (let index = 0; index < length; index += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

function timeLabel(date) {
  return (
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}

function dateLabel(date) {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];

  return (
    String(date.getMonth() + 1).padStart(2, "0") +
    "/" +
    String(date.getDate()).padStart(2, "0") +
    " 周" +
    weekday
  );
}

function getScreenMetric(ctx, key) {
  const candidates = [
    getAt(ctx, "screen." + key),
    getAt(ctx, "device.screen." + key),
    getAt(ctx, "device.screenSize." + key)
  ];

  try {
    if (typeof screen !== "undefined" && screen && Number(screen[key]) > 0) {
      candidates.push(screen[key]);
    }
  } catch (_) {}

  for (let index = 0; index < candidates.length; index += 1) {
    const value = Number(candidates[index]);

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return "";
}

function detectScheme(ctx) {
  const raw = clean(
    pick(
      ctx.colorScheme,
      ctx.appearance,
      ctx.theme,
      ctx.widgetColorScheme
    )
  ).toLowerCase();

  if (
    raw.includes("dark") ||
    raw.includes("深") ||
    raw === "2"
  ) {
    return "dark";
  }

  return "light";
}

function resolveAdaptiveColor(value, scheme) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return scheme === "dark"
      ? clean(value.dark) || clean(value.light)
      : clean(value.light) || clean(value.dark);
  }

  return "";
}

function clean(value) {
  return String(
    value === undefined || value === null ? "" : value
  ).trim();
}

function clamp(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}

function numberInRange(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function pick() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index];

    if (
      value !== undefined &&
      value !== null &&
      clean(value) !== ""
    ) {
      return value;
    }
  }

  return "";
}

function getAt(object, path) {
  const keys = String(path).split(".");
  let current = object;

  for (let index = 0; index < keys.length; index += 1) {
    if (
      !current ||
      typeof current !== "object" ||
      !(keys[index] in current)
    ) {
      return "";
    }

    current = current[keys[index]];
  }

  return current === undefined || current === null
    ? ""
    : current;
}

function truthy(value) {
  return value === true ||
    value === 1 ||
    ["true", "1", "yes", "y"].includes(
      clean(value).toLowerCase()
    );
}

function parseTrace(value) {
  const output = {};

  String(value || "")
    .split(/\r?\n/)
    .forEach(function (line) {
      const position = line.indexOf("=");

      if (position > 0) {
        output[line.slice(0, position).trim()] =
          line.slice(position + 1).trim();
      }
    });

  return output;
}

function countryCode(value) {
  const code = clean(value).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function flag(value) {
  const code = countryCode(value);
  if (!code) return "";
  return (
    String.fromCodePoint(code.charCodeAt(0) + 127397) +
    String.fromCodePoint(code.charCodeAt(1) + 127397)
  );
}