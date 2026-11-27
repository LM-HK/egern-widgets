/*
 * 名称: 🌤️ 天气 · 透明版（Open-Meteo）
 * Glass fork: 透明版（WIDGET_STYLE 开关，glass 默认透明 / classic 原版）
 * 布局参照用户截图里的天气小组件：顶部城市+更新时间，当前大温度+天气状况+最高最低，
 * 详情三列两行（体感/风/气压/能见度/降水/湿度），底部 5 日预报。
 *
 * 数据：Open-Meteo 免费 API，无需 Key；实时温度与苹果天气实测只差约 0.3°。
 * 注意：Open-Meteo 不提供 AQI 与气象预警，详情里用气压代替 AQI，预警栏省略。
 * AQI 未接入：Open-Meteo 的 CAMS 空气质量预报在无锡与实测站数据差距大
 * （曾报 US AQI 153，而实测站为 30），为避免误导不显示 AQI。
 *
 * 环境变量：
 * CITY — 显示的城市名 (默认: 惠山)
 * LAT  — 纬度 (默认: 31.68)
 * LON  — 经度 (默认: 120.29)
 * WIDGET_STYLE — glass 透明（默认）/ classic 原版
 */
export default async function(ctx) {
  const glass = String(ctx.env?.WIDGET_STYLE || 'glass').trim().toLowerCase() !== 'classic';
  const city = getEnv(ctx.env, ['CITY'], '惠山');
  const lat = toNumber(getEnv(ctx.env, ['LAT'], '31.68'), 31.68);
  const lon = toNumber(getEnv(ctx.env, ['LON'], '120.29'), 120.29);

  const family = ctx.widgetFamily || 'systemMedium';
  const isSmall = family === 'systemSmall';
  const isMedium = family === 'systemMedium';
  const isLarge = family === 'systemLarge' || family === 'systemExtraLarge';

  const apiUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation'
    + '&hourly=visibility'
    + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
    + '&timezone=Asia%2FShanghai&forecast_days=6';

  let data = null;
  let isError = false;
  let usedCache = false;

  try {
    const resp = await ctx.http.get(apiUrl, { timeout: 8000 });
    data = await resp.json();
    if (!data || !data.current || !data.daily) throw new Error('bad data');
    try { ctx.storage && ctx.storage.set && ctx.storage.set('weather-cache', JSON.stringify(data)); } catch (_) {}
  } catch (e) {
    isError = true;
    try {
      const cached = ctx.storage && ctx.storage.get && ctx.storage.get('weather-cache');
      if (cached) { data = JSON.parse(cached); usedCache = true; isError = false; }
    } catch (_) {}
  }

  if (!data) {
    return {
      type: 'widget',
      ...(glass ? {} : { backgroundGradient: { type: 'linear', colors: ['#1A1A2E', '#16213E'], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } } }),
      padding: 16,
      children: [{ type: 'text', text: '天气获取失败', textColor: '#FF3B30', font: { size: 'subheadline' } }]
    };
  }

  const cur = data.current;
  const daily = data.daily;
  const cond = WMO[cur.weather_code] || WMO[3];
  const temp = Math.round(cur.temperature_2m);
  const feels = Math.round(cur.apparent_temperature);
  const humidity = Math.round(cur.relative_humidity_2m);
  const pressure = Math.round(cur.surface_pressure);
  const precip = (cur.precipitation || 0).toFixed(1);
  const windTxt = windDir(cur.wind_direction_10m) + ' ' + beaufort(cur.wind_speed_10m) + '级';
  const high = Math.round(daily.temperature_2m_max[0]);
  const low = Math.round(daily.temperature_2m_min[0]);
  const visibility = currentVisibility(data);
  const updateTime = String(cur.time || '').slice(11, 16) || nowHM();
  const dateLabel = dateWeekday(cur.time);

  // 5 日预报：从明天起
  const days = [];
  for (let i = 1; i <= 5 && i < daily.time.length; i++) {
    const d = WMO[daily.weather_code[i]] || WMO[3];
    days.push({
      label: i === 1 ? '明天' : weekdayName(daily.time[i]),
      icon: d.icon,
      cond: d.text,
      high: Math.round(daily.temperature_2m_max[i]),
      low: Math.round(daily.temperature_2m_min[i])
    });
  }

  const titleColor = '#FFFFFF';
  const subColor = glass ? 'rgba(255,255,255,0.75)' : '#CCCCCC';
  const dimColor = glass ? 'rgba(255,255,255,0.6)' : '#999999';

  const pad = isLarge ? 18 : (isSmall ? 12 : 12);
  const children = [];

  // ===== 顶部：城市 + 更新时间 =====
  children.push({
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      { type: 'text', text: '⌖ ' + city, font: { size: 'subheadline', weight: 'bold' }, textColor: titleColor },
      { type: 'spacer' },
      { type: 'text', text: updateTime + (usedCache ? ' · 缓存' : ''), font: { size: 'caption1' }, textColor: dimColor }
    ]
  });

  if (isSmall) {
    // ===== 小号：大温度 + 状况 + 最高最低 =====
    children.push({ type: 'spacer', length: 6 });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
      children: [
        { type: 'text', text: temp + '°', font: { size: 44, weight: 'bold' }, textColor: titleColor },
        { type: 'text', text: cond.icon, font: { size: 28 } }
      ]
    });
    children.push({ type: 'spacer', length: 2 });
    children.push({ type: 'text', text: cond.text + '  ' + high + '° / ' + low + '°', font: { size: 'footnote' }, textColor: subColor });
    children.push({ type: 'spacer' });
    children.push({ type: 'text', text: '体感 ' + feels + '° · ' + windTxt, font: { size: 'caption1' }, textColor: dimColor });
  } else {
    // ===== 中号 / 大号：当前天气行 =====
    children.push({ type: 'spacer', length: 4 });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center',
      children: [
        { type: 'text', text: temp + '°', font: { size: isLarge ? 56 : 46, weight: 'bold' }, textColor: titleColor },
        { type: 'text', text: cond.icon, font: { size: isLarge ? 34 : 28 } },
        { type: 'spacer' },
        {
          type: 'stack', direction: 'column', alignItems: 'end', gap: 1,
          children: [
            { type: 'text', text: dateLabel, font: { size: 'caption1' }, textColor: subColor },
            { type: 'text', text: cond.text, font: { size: 'subheadline', weight: 'medium' }, textColor: titleColor },
            { type: 'text', text: '高 ' + high + '°  低 ' + low + '°', font: { size: 'subheadline', weight: 'bold' }, textColor: titleColor }
          ]
        }
      ]
    });

    // ===== 详情三列两行 =====
    children.push({ type: 'spacer', length: 6 });
    const detailCell = (label, value) => ({
      type: 'stack', direction: 'column', alignItems: 'center', gap: 1, flex: 1,
      children: [
        { type: 'text', text: label, font: { size: 'caption2' }, textColor: dimColor },
        { type: 'text', text: value, font: { size: 'caption1', weight: 'medium' }, textColor: titleColor }
      ]
    });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center',
      children: [
        detailCell('体感', feels + '°'),
        detailCell('风', windTxt),
        detailCell('气压', pressure + ' hPa')
      ]
    });
    children.push({ type: 'spacer', length: 4 });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center',
      children: [
        detailCell('能见度', visibility),
        detailCell('降水', precip + 'mm'),
        detailCell('湿度', humidity + '%')
      ]
    });

    // ===== 5 日预报 =====
    children.push({ type: 'spacer', length: 8 });
    const dayCell = (d) => ({
      type: 'stack', direction: 'column', alignItems: 'center', gap: 2, flex: 1,
      children: [
        { type: 'text', text: d.label, font: { size: 'caption1' }, textColor: subColor },
        { type: 'text', text: d.icon, font: { size: isLarge ? 22 : 18 } },
        { type: 'text', text: d.cond, font: { size: 'caption2' }, textColor: subColor },
        { type: 'text', text: d.high + '° ' + d.low + '°', font: { size: 'caption1', weight: 'bold' }, textColor: titleColor }
      ]
    });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'start',
      children: days.map(dayCell)
    });
  }

  return {
    type: 'widget',
    ...(glass ? {} : { backgroundGradient: { type: 'linear', colors: ['#1A1A2E', '#16213E'], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } } }),
    padding: pad,
    gap: 0,
    children
  };
}

function getEnv(env, names, fallback) {
  for (const name of names) {
    const v = env && env[name];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowHM() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function dateWeekday(iso) {
  try {
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + weeks[d.getDay()];
  } catch (_) {
    return '';
  }
}

function weekdayName(dateStr) {
  try {
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return weeks[d.getDay()];
  } catch (_) {
    return '';
  }
}

function windDir(deg) {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const d = ((Number(deg) % 360) + 360) % 360;
  return dirs[Math.round(d / 45) % 8] + '风';
}

function beaufort(kmh) {
  const v = Number(kmh) || 0;
  if (v < 1) return 0;
  if (v < 6) return 1;
  if (v < 12) return 2;
  if (v < 20) return 3;
  if (v < 29) return 4;
  if (v < 39) return 5;
  if (v < 50) return 6;
  if (v < 62) return 7;
  if (v < 75) return 8;
  if (v < 89) return 9;
  if (v < 103) return 10;
  if (v < 118) return 11;
  return 12;
}

function currentVisibility(data) {
  try {
    const hourly = data.hourly || {};
    const times = hourly.time || [];
    const vis = hourly.visibility || [];
    const cur = String((data.current && data.current.time) || '').slice(0, 13) + ':00';
    const idx = times.indexOf(cur);
    if (idx >= 0 && vis[idx] !== undefined && vis[idx] !== null) {
      const km = Number(vis[idx]) / 1000;
      return (km >= 10 ? Math.round(km) : km.toFixed(1)) + 'km';
    }
  } catch (_) {}
  return '--';
}

const WMO = {
  0: { text: '晴', icon: '☀️' },
  1: { text: '晴', icon: '🌤️' },
  2: { text: '多云', icon: '⛅' },
  3: { text: '阴', icon: '☁️' },
  45: { text: '雾', icon: '🌫️' },
  48: { text: '雾', icon: '🌫️' },
  51: { text: '毛毛雨', icon: '🌦️' },
  53: { text: '毛毛雨', icon: '🌦️' },
  55: { text: '毛毛雨', icon: '🌦️' },
  56: { text: '冻毛毛雨', icon: '🌧️' },
  57: { text: '冻毛毛雨', icon: '🌧️' },
  61: { text: '小雨', icon: '🌧️' },
  63: { text: '中雨', icon: '🌧️' },
  65: { text: '大雨', icon: '🌧️' },
  66: { text: '冻雨', icon: '🌧️' },
  67: { text: '冻雨', icon: '🌧️' },
  71: { text: '小雪', icon: '❄️' },
  73: { text: '中雪', icon: '❄️' },
  75: { text: '大雪', icon: '❄️' },
  77: { text: '雪粒', icon: '❄️' },
  80: { text: '阵雨', icon: '🌦️' },
  81: { text: '阵雨', icon: '🌦️' },
  82: { text: '暴雨', icon: '🌧️' },
  85: { text: '阵雪', icon: '🌨️' },
  86: { text: '阵雪', icon: '🌨️' },
  95: { text: '雷阵雨', icon: '⛈️' },
  96: { text: '雷阵雨伴冰雹', icon: '⛈️' },
  99: { text: '雷阵雨伴冰雹', icon: '⛈️' }
};
