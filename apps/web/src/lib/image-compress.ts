/**
 * 客户端图片压缩：canvas 重采样 + JPEG 有损压缩，上传前减小体积，节省服务器带宽与存储。
 * - 长边超过 maxEdge 时等比缩小
 * - 输出 image/jpeg（透明 PNG 会铺白底）
 * - 返回压缩后的 File 与原始/压缩后体积
 */
export interface CompressResult {
  file: File;
  originalSize: number;
  compressedSize: number;
}

export async function compressImage(
  file: File,
  maxEdge = 1600,
  quality = 0.82,
): Promise<CompressResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('仅支持图片文件');
  }
  // 小图且已是 jpeg/png/webp 时，仍统一走一遍 canvas（统一格式、剥离 EXIF，隐私更好）
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas 压缩');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  let blob: Blob | null = null;
  // 大图逐级降质量，尽量控制在 ~500KB 内
  let q = quality;
  for (let i = 0; i < 4; i++) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
    if (blob && (blob.size <= 500 * 1024 || q <= 0.5)) break;
    q = Math.max(0.5, q - 0.12);
  }
  if (!blob) throw new Error('图片压缩失败');

  const baseName = (file.name.replace(/\.[^.]+$/, '') || 'image').slice(0, 40);
  const compressed = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  return { file: compressed, originalSize: file.size, compressedSize: compressed.size };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = src;
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
