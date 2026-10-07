/**
 * 商城资源表单：粘贴智能解析
 * 1. 图床图片链接 → 规范化为 <img> 标签（补协议、转义、限宽样式）
 * 2. 网盘分享文本/链接 → 抽取链接 + 自动识别平台 + 抠提取码/访问码
 */

// ===== 网盘平台识别 =====
export interface PanLink {
  url: string;
  platform: string; // baidu | lanzou | quark | aliyun | tianyi | xunlei | 123pan | other
  platformLabel: string;
  pwd: string | null; // 提取码
}

const PAN_PATTERNS: Array<{ re: RegExp; platform: string; label: string }> = [
  { re: /pan\.baidu\.com/i, platform: 'baidu', label: '百度网盘' },
  { re: /lanzou[a-z]?\.com|lanzn\.com|lanzoui\.com|lanzoux\.com|lanzouy\.com/i, platform: 'lanzou', label: '蓝奏云' },
  { re: /pan\.quark\.cn/i, platform: 'quark', label: '夸克网盘' },
  { re: /aliyundrive\.com|alipan\.com/i, platform: 'aliyun', label: '阿里云盘' },
  { re: /cloud\.189\.cn/i, platform: 'tianyi', label: '天翼云盘' },
  { re: /pan\.xunlei\.com/i, platform: 'xunlei', label: '迅雷云盘' },
  { re: /123pan\.com|123684\.com|123865\.com/i, platform: '123pan', label: '123 网盘' },
];

/** 从任意文本中抽取网盘链接（支持分享消息整段粘贴） */
export function extractPanLinks(text: string): PanLink[] {
  const results: PanLink[] = [];
  const seen = new Set<string>();
  // 常见分享文本形态：链接可能带引号/书名号/中文标点包裹
  const urlRe = /https?:\/\/[^\s"'<>，。；、）】》"']+/gi;
  const matches = String(text || '').match(urlRe) || [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;!?）】》"']+$/g, '');
    const hit = PAN_PATTERNS.find((p) => p.re.test(url));
    if (!hit || seen.has(url)) continue;
    seen.add(url);
    results.push({ url, platform: hit.platform, platformLabel: hit.label, pwd: null });
  }
  // 抽提取码：链接附近的 提取码/访问码/密码：XXXX（3-6 位字母数字）
  if (results.length) {
    const pwdRe = /(?:提取码|访问码|密码|提取碼|pwd)\s*[:：=]?\s*([a-zA-Z0-9]{3,8})/gi;
    let m: RegExpExecArray | null;
    const pwds: string[] = [];
    while ((m = pwdRe.exec(String(text || ''))) !== null) {
      pwds.push(m[1]);
    }
    if (pwds.length) {
      results.forEach((r, i) => { r.pwd = pwds[Math.min(i, pwds.length - 1)]; });
    }
  }
  return results;
}

/** 识别单个 URL 的平台（无匹配返回 null） */
export function detectPanPlatform(url: string): { platform: string; label: string } | null {
  const hit = PAN_PATTERNS.find((p) => p.re.test(String(url || '')));
  return hit ? { platform: hit.platform, label: hit.label } : null;
}

// ===== 图床链接规范化 =====
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?.*)?$/i;
const IMAGE_HOST_RE = /(\.|\/\/)(imgur|sm\.ms|smms|lsky|imgse|tu\.bijijiang|imagehub|postimg|ibb\.co|imgbb|cdn|static|img|pic|image)/i;

/** 判断 URL 是否像图片 */
export function looksLikeImageUrl(url: string): boolean {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  return IMAGE_EXT_RE.test(u) || IMAGE_HOST_RE.test(u);
}

/** 从粘贴文本抽取图片 URL（支持一段文本里混多张图） */
export function extractImageUrls(text: string): string[] {
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>，。；、）】》"']+/gi) || [];
  const cleaned = urls.map((u) => u.replace(/[.,;!?）】》"']+$/g, ''));
  return Array.from(new Set(cleaned.filter(looksLikeImageUrl)));
}

const escapeAttr = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 把图片 URL 规范化为安全、自适应宽度的 <img> 标签 */
export function buildImageTag(url: string): string {
  const safe = escapeAttr(String(url || '').trim());
  return `<img src="${safe}" alt="" style="max-width:100%;height:auto;border-radius:8px" loading="lazy" />`;
}

/** 补协议（用户常粘 //xxx 或缺 https 的域名） */
export function normalizeUrl(u: string): string {
  let s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s) && /^[\w-]+(\.[\w-]+)+/.test(s)) s = `https://${s}`;
  return s;
}

/** 在 textarea 光标处插入文本 */
export function insertAtCursor(textarea: HTMLTextAreaElement | null, current: string, snippet: string): string {
  const pos = textarea ? textarea.selectionStart : current.length;
  const before = current.slice(0, pos);
  const after = current.slice(pos);
  const sep = before && !before.endsWith('\n') ? '\n' : '';
  return `${before}${sep}${snippet}${after.startsWith('\n') || !after ? '' : '\n'}${after}`;
}
