/*
 * 花云到期倒计时小组件（Egern 通用格式）
 *
 * 静态倒计时：花云订阅是阅后即焚链接，只能拉一次，实时用量读不到，
 * 所以只显示套餐到期倒计时（剩余天数、到期日、续费）。
 * 到期日等在模块设置里改；续费后把到期日改成新的日期即可。
 *
 * 环境变量：
 *   PLAN         套餐名，默认“花云 Lite 150G”
 *   START_DATE   服务开始日 YYYY-MM-DD，默认 2026-11-14（用于进度条）
 *   EXPIRE_DATE  到期日 YYYY-MM-DD，默认 2026-12-13
 *   FEE          续费，默认“¥39/月”
 *   WIDGET_STYLE glass 透明（默认）/ classic 原版
 */

const DAY = 86400000;

function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}

function shortDate(d) {
  return (d.getMonth() + 1) + '.' + d.getDate();
}

export default async function(ctx) {
  const env = ctx.env || {};
  const glass = String(env.WIDGET_STYLE || 'glass').trim().toLowerCase() !== 'classic';
  const plan = String(env.PLAN || '花云 Lite 150G').trim() || '花云 Lite 150G';
  const fee = String(env.FEE || '¥39/月').trim() || '¥39/月';
  const expire = parseDate(env.EXPIRE_DATE || '2026-12-13') || parseDate('2026-12-13');
  const start = parseDate(env.START_DATE || '2026-11-14');

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((expire - today) / DAY);
  const totalDays = start ? Math.round((expire - start) / DAY) : 0;
  const elapsed = start ? Math.round((today - start) / DAY) : 0;

  const expireStr = expire.getFullYear() + '-' +
    String(expire.getMonth() + 1).padStart(2, '0') + '-' +
    String(expire.getDate()).padStart(2, '0');

  const status = daysLeft > 0 ? '后到期' : (daysLeft === 0 ? '今天到期' : '已到期');
  const bigNum = String(Math.abs(daysLeft));
  const family = ctx.widgetFamily || 'systemSmall';

  // ====== 锁屏小组件 ======
  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: daysLeft > 0 ? '🌸花云剩' + daysLeft + '天' : '🌸花云' + status }] };
  }
  if (family === 'accessoryRectangular') {
    return {
      type: 'widget', gap: 4,
      children: [
        { type: 'text', text: '🌸 花云 ' + (daysLeft > 0 ? '剩余' + daysLeft + '天' : status), font: { size: 'headline', weight: 'bold' } },
        { type: 'text', text: '到期 ' + expireStr, font: { size: 'caption1' } }
      ]
    };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      children: [
        {
          type: 'stack', direction: 'column', alignItems: 'center', gap: 0,
          children: [
            { type: 'text', text: bigNum, font: { size: 'headline', weight: 'bold' } },
            { type: 'text', text: '天', font: { size: 'caption2' } }
          ]
        }
      ]
    };
  }

  // ====== 主屏幕小组件 ======
  const isSmall = family === 'systemSmall';
  const isMedium = family === 'systemMedium';
  const isLarge = family === 'systemLarge' || family === 'systemExtraLarge';
  const paddingVal = isLarge ? 24 : 16;

  const children = [
    // 标题行
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
      children: [
        { type: 'image', src: 'sf-symbol:hourglass', color: '#FF9500', width: 16, height: 16 },
        { type: 'text', text: plan, font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' }
      ]
    },
    { type: 'spacer', length: 8 },
    // 倒计时大数字
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        { type: 'text', text: bigNum, font: { size: 44, weight: 'bold' }, textColor: '#FFFFFF' },
        { type: 'text', text: '天', font: { size: 20, weight: 'medium' }, textColor: '#FFFFFF' },
        { type: 'text', text: status, font: { size: 'subheadline' }, textColor: '#FFFFFF' }
      ]
    }
  ];

  // 中/大号：进度条 + 服务期
  if ((isMedium || isLarge) && totalDays > 0) {
    const pct = Math.min(1, Math.max(0, elapsed / totalDays));
    const filled = Math.round(pct * 12);
    const bar = '█'.repeat(filled) + '░'.repeat(12 - filled);
    children.push({ type: 'spacer', length: 10 });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
      children: [
        { type: 'text', text: bar, font: { size: 'footnote' }, textColor: '#FFFFFF' },
        { type: 'text', text: Math.round(pct * 100) + '%', font: { size: 'footnote', weight: 'bold' }, textColor: '#34C759' }
      ]
    });
    children.push({ type: 'spacer', length: 6 });
    children.push({
      type: 'text',
      text: '服务期 ' + shortDate(start) + '–' + shortDate(expire) + ' · 已用 ' + Math.max(0, elapsed) + ' 天 / 共 ' + totalDays + ' 天',
      font: { size: 'footnote' }, textColor: '#FFFFFF'
    });
  }

  children.push({ type: 'spacer' });
  // 底部：到期日 + 续费
  children.push({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      { type: 'text', text: '到期 ' + expireStr, font: { size: 'caption1' }, textColor: '#FFFFFF' },
      { type: 'text', text: '· 续费 ' + fee, font: { size: 'caption1' }, textColor: '#FFFFFF' }
    ]
  });

  return {
    type: 'widget',
    ...(glass ? {} : {
      backgroundGradient: {
        type: 'linear',
        colors: ['#1A1A2E', '#16213E'],
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 1, y: 1 }
      }
    }),
    padding: paddingVal,
    refreshAfter: new Date(Date.now() + 60 * 60 * 1000),
    children
  };
}
