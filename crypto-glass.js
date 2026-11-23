/**
 * ════════════════════════════════════════════════════
 *  虚拟货币价格小组件
 *  数据源：Binance Vision（主）+ CoinGecko（备用），均无需 Key
 *  2026-11-23 优化：币安主站 api.binance.com 在中国和美国都会返回 451（地区限制），
 *  所以小组件一直报错；改用币安公开行情接口 data-api.binance.vision（同款返回格式），
 *  失败时再走 CoinGecko /coins/markets 补齐；全部失败则显示上次缓存的数据，不再整页报错。
 *  请求默认走 POLICY 代理策略（默认花云，出口在境外），失败自动改直连；
 *  POLICY 留空则全程直连。
 *
 * Glass fork: 透明版（WIDGET_STYLE 开关，glass 默认透明 / classic 原版）
 * 原版根背景未设置、走 Egern 默认；glass 下根背景显式透明，classic 用 theme.bg。
 * 币种默认 BTC,ETH,BNB（三个），文字用原版深浅自适应颜色，卡片与涨跌徽章为半透明底。
 * ════════════════════════════════════════════════════
 *
 * ⚙️ 配置方法：
 *   在 Egern 小组件配置环境变量中添加 `btcType` 参数
 *   格式：币种符号，多个用英文逗号分隔
 *
 * 💡 配置示例：
 *   ✓ btcType: "BTC"                    // 只显示比特币
 *   ✓ btcType: "BTC,ETH"                // 显示比特币+以太坊
 *   ✓ btcType: "BTC, ETH, BNB"          // 空格会自动忽略
 *   ✓ 最多支持 8 个币种，超出部分自动忽略
 *
 * 📊 尺寸说明：
 *   • 小尺寸  : 显示 3 个币种卡片（币种、名称、价格、涨跌幅）
 *   • 中尺寸  : 显示 3 个币种列表
 *   • 大尺寸  : 显示 8 个币种列表
 *   • 锁屏    : 单行 / 圆形 / 矩形（矩形显示 3 个币种）
 *
 * 🎨 深色模式：
 *   • 所有颜色使用 { light, dark } 格式
 *   • Egern 自动根据系统外观切换，无需手动判断
 *
 * 🔄 刷新说明（重要）：
 *   • refreshAfter 必须传 ISO 8601 时间戳，"PT1M" 这类 duration 写法无效
 *   • iOS WidgetKit 有每日刷新预算，refreshAfter 只是"最早可刷新时间"，
 *     实际刷新频率由系统决定，做不到严格的每分钟实时刷新
 *   • 底部平时保持干净；仅当有币种获取失败时才显示 ⚠️ 提示行，
 *     不会把不完整/过期的数据伪装成实时数据
 *
 * ════════════════════════════════════════════════════
 */

export default async function(ctx) {
  const theme = {
    bg: { light: "#FFFFFF", dark: "#2C2C2E" },
    text: { light: "#000000", dark: "#FFFFFF" },
    textSecondary: { light: "#666666", dark: "#AAAAAA" },
    up: { light: "#00AA00", dark: "#30D158" },
    down: { light: "#FF0000", dark: "#FF453A" }
  };

  // Glass fork: WIDGET_STYLE=glass（默认）根背景透明；classic 为原版实色背景
  const glass = String(ctx.env?.WIDGET_STYLE || 'glass').trim().toLowerCase() !== 'classic';
  const rootBg = glass ? { backgroundColor: '#00000000' } : { backgroundColor: theme.bg };

  // 没有传入尺寸时（例如脚本预览），按小尺寸处理
  const widgetFamily = ctx.widgetFamily || "systemSmall";
  const btcType = ctx.env?.btcType || "BTC,ETH,BNB";
  // 代理策略：默认走花云（出口在境外，币安行情接口可达）；留空则直连
  const POLICY = String(ctx.env?.POLICY || "花云").trim();
  // 币安主站 api.binance.com 在中国和美国都会返回 451（地区限制），改用币安公开行情接口
  // data-api.binance.vision：同款返回格式，无需 Key，中国/美国都能访问
  const API = "https://data-api.binance.vision/api/v3";
  const COINGECKO_API = "https://api.coingecko.com/api/v3";
  const CACHE_KEY = "crypto-glass.cache.v1";

  // 请求 helper：先走代理策略，失败再直连；POLICY 为空则只直连
  const getJSON = async (url) => {
    const tries = [];
    if (POLICY) tries.push({ policy: POLICY });
    tries.push({});
    let lastErr = null;
    for (const opts of tries) {
      try {
        const resp = await ctx.http.get(url, { timeout: 6000, ...opts });
        return await resp.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("fetch failed");
  };

  // CoinGecko 币种 ID（备用接口用）
  const COINGECKO_ID = {
    "BTC": "bitcoin", "ETH": "ethereum", "BNB": "binancecoin",
    "SOL": "solana", "XRP": "ripple", "ADA": "cardano",
    "DOGE": "dogecoin", "DOT": "polkadot", "MATIC": "matic-network",
    "AVAX": "avalanche-2", "LINK": "chainlink", "UNI": "uniswap",
    "SHIB": "shiba-inu", "PEPE": "pepe", "FLOKI": "floki",
    "BONK": "bonk", "WIF": "dogwifcoin", "BOME": "book-of-meme",
    "TRX": "tron", "LTC": "litecoin", "APT": "aptos"
  };

  // ── 刷新工具：refreshAfter 必须为 ISO 8601 时间戳 ──
  const refreshAfter = (ms) => new Date(Date.now() + ms).toISOString();
  const REFRESH_MS = 60 * 1000;   // 常规刷新请求间隔（实际执行由 iOS 系统预算决定）
  const RETRY_MS = 5 * 60 * 1000;  // 获取失败后的重试间隔

  const SYMBOL_MAP = {
    "BTC": "BTCUSDT", "ETH": "ETHUSDT", "BNB": "BNBUSDT",
    "SOL": "SOLUSDT", "XRP": "XRPUSDT", "ADA": "ADAUSDT",
    "DOGE": "DOGEUSDT", "DOT": "DOTUSDT", "MATIC": "MATICUSDT",
    "AVAX": "AVAXUSDT", "LINK": "LINKUSDT", "UNI": "UNIUSDT",
    "SHIB": "SHIBUSDT", "PEPE": "PEPEUSDT", "FLOKI": "FLOKIUSDT",
    "BONK": "BONKUSDT", "WIF": "WIFUSDT", "BOME": "BOMEUSDT",
    "TRX": "TRXUSDT", "LTC": "LTCUSDT", "APT": "APTUSDT"
  };

  const parseSymbols = (input) => {
    if (!input) return ["BTCUSDT"];
    return input.split(",")
      .map(s => s.trim().toUpperCase())
      .map(s => SYMBOL_MAP[s] || `${s}USDT`)
      .slice(0, 8);
  };

  const formatPrice = (price) => {
    if (price === null || price === undefined) return "0";
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    if (price >= 0.01) return price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
    return price.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 8 });
  };

  // 备用：CoinGecko 一次拉取多个币种（/coins/markets），返回与主接口同款 coin 对象
  const fetchFromCoinGecko = async (baseSymbols) => {
    const ids = baseSymbols.map(s => COINGECKO_ID[s]).filter(Boolean);
    if (!ids.length) return [];
    try {
      const resp = await getJSON(`${COINGECKO_API}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&price_change_percentage=24h`);
      const list = resp;
      if (!Array.isArray(list)) return [];
      return list.map(c => ({
        symbol: String(c.symbol || "").toUpperCase(),
        name: c.name || String(c.symbol || "").toUpperCase(),
        price: Number(c.current_price) || 0,
        high: Number(c.high_24h) || 0,
        low: Number(c.low_24h) || 0,
        change: Number(c.price_change_percentage_24h) || 0,
        volume: Number(c.total_volume) || 0
      })).filter(c => c.symbol && c.price > 0);
    } catch { return []; }
  };

  // 返回 { coins, failed, stale }：stale 表示用的是缓存数据
  const fetchPrices = async () => {
    const symbols = parseSymbols(btcType);
    const coins = [];
    const failed = [];
    try {
      const settled = await Promise.all(
        symbols.map(symbol =>
          getJSON(`${API}/ticker/24hr?symbol=${symbol}`)
            .then(data => ({ ok: true, data }))
            .catch(() => ({ ok: false, symbol }))
        )
      );
      for (const r of settled) {
        if (r.ok && r.data && r.data.symbol) {
          const d = r.data;
          coins.push({
            symbol: d.symbol.replace("USDT", ""),
            name: getCoinName(d.symbol.replace("USDT", "")),
            price: parseFloat(d.lastPrice),
            high: parseFloat(d.highPrice),
            low: parseFloat(d.lowPrice),
            change: parseFloat(d.priceChangePercent),
            volume: parseFloat(d.volume)
          });
        } else {
          failed.push(r.symbol || "?");
        }
      }
    } catch (e) {
      // 主接口整体异常：全部记为失败，走备用接口
      symbols.forEach(s => { if (!failed.includes(s)) failed.push(s); });
    }

    // 备用接口：补齐主接口失败的币种（一次请求全部）
    if (failed.length > 0) {
      const baseFailed = failed.map(s => String(s).replace("USDT", "").toUpperCase());
      const backup = await fetchFromCoinGecko(baseFailed);
      const got = new Set();
      for (const c of backup) {
        coins.push(c);
        got.add(c.symbol + "USDT");
      }
      // 从失败列表里去掉备用接口已补上的
      for (let i = failed.length - 1; i >= 0; i--) {
        if (got.has(failed[i])) failed.splice(i, 1);
      }
    }

    // 成功拿到数据就缓存；全部失败则读缓存顶上，不再整页报错
    if (coins.length > 0) {
      try { ctx.storage?.setJSON(CACHE_KEY, { coins, updatedAt: Date.now() }); } catch {}
      return { coins, failed, stale: false };
    }
    try {
      const cached = ctx.storage?.getJSON(CACHE_KEY);
      if (cached?.coins?.length) {
        return { coins: cached.coins, failed: symbols, stale: true, cachedAt: cached.updatedAt };
      }
    } catch {}
    return { coins: [], failed: symbols, stale: false };
  };

  const getCoinName = (symbol) => {
    const names = {
      "BTC": "Bitcoin", "ETH": "Ethereum", "BNB": "BNB",
      "SOL": "Solana", "XRP": "XRP", "ADA": "Cardano",
      "DOGE": "Dogecoin", "DOT": "Polkadot", "MATIC": "Polygon",
      "AVAX": "Avalanche", "LINK": "Chainlink", "UNI": "Uniswap",
      "SHIB": "Shiba Inu", "PEPE": "Pepe", "FLOKI": "Floki",
      "BONK": "Bonk", "WIF": "dogwifhat", "BOME": "Book of Meme",
      "TRX": "Tron", "LTC": "Litecoin", "APT": "Aptos"
    };
    return names[symbol] || symbol;
  };

  const { coins: dataSource, failed, stale } = await fetchPrices();
  const hasFailure = failed.length > 0;
  const updateTime = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai"
  });

  // 失败提示行：缓存数据时显示“缓存数据”，部分失败时显示失败个数；
  // 正常时不显示，保持界面干净
  const statusLine = () => {
    if (stale) return {
      type: "text",
      text: `⚠️ 缓存数据 · ${updateTime}`,
      font: { size: 10 },
      textColor: theme.down,
      textAlign: "center",
      maxLines: 1,
      minScale: 0.7
    };
    if (!hasFailure) return null;
    return {
      type: "text",
      text: `⚠️ ${failed.length}个币种获取失败 · ${updateTime}`,
      font: { size: 10 },
      textColor: theme.down,
      textAlign: "center",
      maxLines: 1,
      minScale: 0.7
    };
  };

  // 全部获取失败：显示错误页，并安排自动重试（之前这里没有 refreshAfter，会一直卡住）
  if (dataSource.length === 0) {
    return {
      type: "widget", padding: 16, 
      ...rootBg,
      refreshAfter: refreshAfter(RETRY_MS),
      children: [{
        type: "stack", direction: "column", alignItems: "center", gap: 8,
        children: [
          { type: "text", text: "⚠️ 数据加载失败", font: { size: 15, weight: "medium" }, textColor: theme.textSecondary, textAlign: "center" },
          { type: "text", text: "请检查网络连接，稍后自动重试", font: { size: 11 }, textColor: theme.textSecondary, textAlign: "center" }
        ]
      }]
    };
  }

  const renderRow = (coin) => {
    const isUp = coin.change >= 0;
    const color = isUp ? theme.up : theme.down;
    return {
      type: "stack", direction: "row", alignItems: "center", padding: [8, 0],
      url: `https://www.binance.com/zh-CN/price/${coin.symbol}`,
      children: [
        {
          type: "stack", direction: "column", flex: 1,
          children: [
            {
              type: "stack", direction: "row",
              children: [
                { type: "text", text: coin.symbol, font: { size: 15, weight: "semibold" }, textColor: theme.text },
                { type: "spacer", flex: 1 },
                { type: "text", text: `$${formatPrice(coin.price)}`, font: { size: 15, weight: "semibold" }, textColor: theme.text, textAlign: "right" }
              ]
            },
            {
              type: "stack", direction: "row",
              children: [
                { type: "text", text: coin.name, font: { size: 11 }, textColor: theme.textSecondary },
                { type: "spacer", flex: 1 },
                { type: "text", text: `H:${formatPrice(coin.high)} L:${formatPrice(coin.low)}`, font: { size: 11 }, textColor: theme.textSecondary, textAlign: "right" }
              ]
            }
          ]
        },
        { type: "spacer", length: 8 },
        {
          type: "stack", width: 70, height: 26, alignItems: "center", justifyContent: "center", borderRadius: 4,
          backgroundColor: isUp ? { light: "#00AA0015", dark: "#30D15825" } : { light: "#FF000015", dark: "#FF453A25" },
          borderWidth: 1,
          borderColor: isUp ? { light: "#00AA0050", dark: "#30D15860" } : { light: "#FF000050", dark: "#FF453A60" },
          children: [{
            type: "text", text: `${isUp ? "+" : ""}${coin.change.toFixed(2)}%`,
            font: { size: 11, weight: "semibold" },
            textColor: isUp ? { light: "#008800", dark: "#4CD964" } : { light: "#CC0000", dark: "#FF6B62" },
            textAlign: "center", maxLines: 1, minScale: 0.6
          }]
        }
      ]
    };
  };

  // ═══════════ 锁屏专用布局（仅 accessory 系列生效）═══════════
  if (widgetFamily.startsWith("accessory")) {
    // 锁屏背景透明，文字颜色交给系统处理，次要文字用半透明白色
    const SUB = { light: "#FFFFFFB3", dark: "#FFFFFFB3" };
    const sign = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
    // 锁屏空间小：1000 以上不显示小数
    const lockPrice = (p) => p >= 1000 ? Math.round(p).toLocaleString("en-US") : formatPrice(p);
    const compact = (p) => p >= 1000 ? `${(p / 1000).toFixed(1)}K` : formatPrice(p);
    const c1 = dataSource[0];

    // 单行：BTC $82,256 -0.63%
    if (widgetFamily === "accessoryInline") {
      return {
        type: "widget", refreshAfter: refreshAfter(REFRESH_MS),
        children: [{
          type: "text",
          text: `${c1.symbol} $${lockPrice(c1.price)} ${sign(c1.change)}`,
          font: { size: "caption1", weight: "medium" },
          maxLines: 1, minScale: 0.5
        }]
      };
    }

    // 圆形：币种 / 价格 / 涨跌幅
    if (widgetFamily === "accessoryCircular") {
      return {
        type: "widget", padding: 2, refreshAfter: refreshAfter(REFRESH_MS),
        children: [
          { type: "spacer" },
          { type: "text", text: c1.symbol, font: { size: "caption2", weight: "medium" }, textColor: SUB, textAlign: "center", maxLines: 1 },
          { type: "text", text: compact(c1.price), font: { size: "headline", weight: "bold" }, textAlign: "center", maxLines: 1, minScale: 0.5 },
          { type: "text", text: sign(c1.change), font: { size: "caption2" }, textColor: SUB, textAlign: "center", maxLines: 1, minScale: 0.6 },
          { type: "spacer" }
        ]
      };
    }

    // 矩形：三行，左边币种，右边加粗价格 + 涨跌幅；有失败时追加一行提示
    const line = (coin) => ({
      type: "stack", direction: "row", alignItems: "center", gap: 4,
      children: [
        { type: "text", text: coin.symbol, font: { size: "caption2", weight: "medium" }, textColor: SUB, maxLines: 1 },
        { type: "spacer" },
        { type: "text", text: `$${lockPrice(coin.price)}`, font: { size: "caption1", weight: "bold" }, maxLines: 1, minScale: 0.6 },
        { type: "text", text: sign(coin.change), font: { size: "caption2" }, textColor: SUB, maxLines: 1, minScale: 0.6 }
      ]
    });

    const rectChildren = dataSource.slice(0, 3).map(line);
    if (stale) {
      rectChildren.push({
        type: "text",
        text: `⚠️ 缓存数据 ${updateTime}`,
        font: { size: "caption2" }, textColor: SUB, textAlign: "center",
        maxLines: 1, minScale: 0.6
      });
    } else if (hasFailure) {
      rectChildren.push({
        type: "text",
        text: `⚠️ ${failed.length}个币种失败 ${updateTime}`,
        font: { size: "caption2" }, textColor: SUB, textAlign: "center",
        maxLines: 1, minScale: 0.6
      });
    }

    return {
      type: "widget", padding: 2, gap: 2, refreshAfter: refreshAfter(REFRESH_MS),
      children: rectChildren
    };
  }
  // ═══════════ 锁屏专用布局结束 ═══════════

  // ═══════════ 小尺寸专用布局：每个币种一张卡片 ═══════════
  if (widgetFamily === "systemSmall") {
    // 小尺寸空间有限：1000 以上不显示小数
    const smallPrice = (p) => p >= 1000 ? `$${Math.round(p).toLocaleString("en-US")}` : `$${formatPrice(p)}`;

    const smallCard = (coin) => {
      const isUp = coin.change >= 0;
      const color = isUp ? theme.up : theme.down;
      return {
        type: "stack", direction: "row", alignItems: "center", flex: 1, gap: 6,
        padding: [4, 8, 4, 8], borderRadius: 12,
        backgroundColor: { light: "#FFFFFF15", dark: "#FFFFFF10" },
        url: `https://www.binance.com/zh-CN/price/${coin.symbol}`,
        children: [
          {
            // 左边：币种 + 全称
            type: "stack", direction: "column",
            children: [
              {
                type: "stack", direction: "row", alignItems: "center",
                children: [
                  { type: "text", text: coin.symbol, font: { size: 15, weight: "bold" }, textColor: theme.text, maxLines: 1 },
                  { type: "spacer" }
                ]
              },
              {
                type: "stack", direction: "row", alignItems: "center",
                children: [
                  { type: "text", text: coin.name, font: { size: 10 }, textColor: theme.textSecondary, maxLines: 1, minScale: 0.7 },
                  { type: "spacer" }
                ]
              }
            ]
          },
          { type: "spacer" },
          {
            // 右边：价格 + 涨跌幅
            type: "stack", direction: "column",
            children: [
              {
                type: "stack", direction: "row", alignItems: "center",
                children: [
                  { type: "spacer" },
                  { type: "text", text: smallPrice(coin.price), font: { size: 15, weight: "semibold" }, textColor: theme.text, maxLines: 1, minScale: 0.6 }
                ]
              },
              {
                type: "stack", direction: "row", alignItems: "center",
                children: [
                  { type: "spacer" },
                  { type: "text", text: `${isUp ? "+" : ""}${coin.change.toFixed(2)}%`, font: { size: 11, weight: "semibold" }, textColor: color, maxLines: 1, minScale: 0.7 }
                ]
              }
            ]
          }
        ]
      };
    };

    return {
      type: "widget", padding: 10, gap: 6, 
      ...rootBg,
      url: `https://www.binance.com/zh-CN/price/${dataSource[0].symbol}`,
      refreshAfter: refreshAfter(REFRESH_MS),
      children: [...dataSource.slice(0, 3).map(smallCard), ...(hasFailure ? [statusLine()] : [])]
    };
  }
  // ═══════════ 小尺寸专用布局结束 ═══════════

  if (widgetFamily === "systemMedium") {
    return {
      type: "widget", padding: 12, 
      ...rootBg,
      refreshAfter: refreshAfter(REFRESH_MS),
      children: [
        ...dataSource.slice(0, 3).flatMap((coin, i) => [renderRow(coin), i < 2 ? { type: "spacer", length: 6 } : null]).filter(Boolean),
        ...(hasFailure ? [statusLine()] : [])
      ]
    };
  }

  return {
    type: "widget", padding: 12, 
    ...rootBg,
    refreshAfter: refreshAfter(REFRESH_MS),
    children: [
      ...dataSource.slice(0, 8).flatMap((coin, i) => [
        renderRow(coin),
        i < 7 ? { type: "spacer", length: 6 } : null
      ]).filter(Boolean),
      ...(hasFailure ? [statusLine()] : [])
    ]
  };
}
