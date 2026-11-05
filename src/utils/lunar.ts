import { WorkStatus } from '../types';

const LUNAR_DAYS = [
  '',
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
];

const NUMERIC_MONTH_MAP: Record<string, string> = {
  '1': '正月',
  '2': '二月',
  '3': '三月',
  '4': '四月',
  '5': '五月',
  '6': '六月',
  '7': '七月',
  '8': '八月',
  '9': '九月',
  '10': '十月',
  '11': '十一月',
  '12': '十二月',
  '冬月': '十一月',
  '臘月': '十二月'
};

const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const ZODIACS = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];

export interface LunarDateInfo {
  monthDay: string;      // 例：正月廿九
  ganZhiYear: string;    // 例：癸巳年
  zodiac: string;        // 例：蛇
  age: number;           // 例：72
  ageLabel: string;      // 例：72歲 或 享壽82歲
  subLabel: string;      // 例：癸巳年 · 屬蛇 · 72歲
}

export function calculateAge(birthdayStr: string, isAlive = true, passingDateStr?: string): number | null {
  if (!birthdayStr || !/^\d{4}-\d{2}-\d{2}$/.test(birthdayStr)) return null;
  const [by, bm, bd] = birthdayStr.split('-').map(Number);
  if (!by || !bm || !bd) return null;

  let refYear = new Date().getFullYear();
  let refMonth = new Date().getMonth() + 1;
  let refDay = new Date().getDate();

  if (!isAlive && passingDateStr && /^\d{4}-\d{2}-\d{2}$/.test(passingDateStr)) {
    const [py, pm, pd] = passingDateStr.split('-').map(Number);
    if (py && pm && pd) {
      refYear = py;
      refMonth = pm;
      refDay = pd;
    }
  }

  let age = refYear - by;
  if (refMonth < bm || (refMonth === bm && refDay < bd)) {
    age -= 1;
  }
  return Math.max(0, age);
}

/**
 * 將西元國曆日期 (YYYY-MM-DD) 自動轉換為台灣習慣的農曆生日字串、天干地支、生肖與歲數
 */
export function convertSolarToLunar(
  solarDateStr: string,
  isAlive = true,
  passingDateStr?: string
): LunarDateInfo | null {
  if (!solarDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(solarDateStr)) {
    return null;
  }

  const [y, m, d] = solarDateStr.split('-').map(Number);
  if (!y || !m || !d) return null;

  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return null;

  try {
    const formatter = new Intl.DateTimeFormat('zh-TW-u-ca-chinese', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });

    const parts = formatter.formatToParts(date);
    let relatedYear = y;
    let rawMonth = '';
    let rawDay = '';

    for (const part of parts) {
      if ((part.type as string) === 'relatedYear') {
        relatedYear = parseInt(part.value, 10) || y;
      } else if (part.type === 'month') {
        rawMonth = part.value;
      } else if (part.type === 'day') {
        rawDay = part.value;
      }
    }

    let normalizedMonth = rawMonth;
    const isLeap = rawMonth.includes('閏');
    const cleanMonthKey = rawMonth.replace('閏', '').replace('月', '');

    if (NUMERIC_MONTH_MAP[rawMonth]) {
      normalizedMonth = NUMERIC_MONTH_MAP[rawMonth];
    } else if (NUMERIC_MONTH_MAP[cleanMonthKey]) {
      normalizedMonth = (isLeap ? '閏' : '') + NUMERIC_MONTH_MAP[cleanMonthKey];
    } else if (!normalizedMonth.endsWith('月')) {
      normalizedMonth = `${normalizedMonth}月`;
    }

    const dayNum = parseInt(rawDay, 10);
    const normalizedDay =
      !isNaN(dayNum) && dayNum >= 1 && dayNum <= 30 ? LUNAR_DAYS[dayNum] : rawDay;

    // 計算農曆天干地支年與生肖 (以農曆年 relatedYear 為準)
    const offset = (relatedYear - 4) % 60;
    const stemIndex = ((offset % 10) + 10) % 10;
    const branchIndex = ((offset % 12) + 12) % 12;
    const ganZhiYear = `${STEMS[stemIndex]}${BRANCHES[branchIndex]}年`;
    const zodiac = ZODIACS[branchIndex];

    const age = calculateAge(solarDateStr, isAlive, passingDateStr) ?? 0;
    const ageLabel = isAlive ? `${age}歲` : `享壽 ${age}歲`;

    const monthDay = `${normalizedMonth}${normalizedDay}`;
    return {
      monthDay,
      ganZhiYear,
      zodiac,
      age,
      ageLabel,
      subLabel: `${ganZhiYear} · 屬${zodiac} · ${ageLabel}`
    };
  } catch (e) {
    console.error('Lunar conversion error:', e);
    return null;
  }
}

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  studying: '在學',
  working: '在職',
  retired: '退休',
  homemaker: '家管 / 自由'
};

export function formatWorkDisplay(status: WorkStatus, detail?: string): string {
  const statusLabel = WORK_STATUS_LABELS[status] || '在職';
  const cleanDetail = (detail || '').trim();
  return cleanDetail ? `${statusLabel} / ${cleanDetail}` : statusLabel;
}
