import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  platformApi,
  type MallResourceItem,
  type MallResourcePayload,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';
import { compressImage, formatBytes } from '@/lib/image-compress';

const CATEGORIES = [
  { key: 'ebook', label: '电子书' },
  { key: 'textbook', label: '电子教材' },
  { key: 'indicator', label: '电子指标' },
  { key: 'article', label: '收费文章' },
  { key: 'other', label: '其他' },
];

const LINK_STATUS_MAP: Record<string, { label: string; color: string }> = {
  ok: { label: '有效', color: '#16a34a' },
  suspect: { label: '疑似失效', color: '#d97706' },
  invalid: { label: '已失效', color: '#dc2626' },
  unknown: { label: '未检测', color: '#6b7280' },
};

interface ResourceFormState {
  id: string;
  title: string;
  category: string;
  summary: string;
  content_html: string;
  cover_url: string;
  required_tier: 'VIP' | 'SVIP';
  download_url: string;
  download_pwd: string;
  sort_order: number;
  published: boolean;
}

const emptyForm = (): ResourceFormState => ({
  id: '',
  title: '',
  category: 'ebook',
  summary: '',
  content_html: '',
  cover_url: '',
  required_tier: 'VIP',
  download_url: '',
  download_pwd: '',
  sort_order: 0,
  published: true,
});

export default function MallResourcesPage() {
  const params = useParams();
  const appId = String(params.appId || params['*'] || '').split('/')[0] || '';
  const [items, setItems] = useState<MallResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState<ResourceFormState>(emptyForm());
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [inlineUploading, setInlineUploading] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!appId) return;
    setLoading(true);
    try {
      const data = await platformApi.listMallResources(appId);
      setItems(data.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载资源列表失败') });
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setFormOpen(true);
  };

  const openEdit = (item: MallResourceItem) => {
    setForm({
      id: item.id,
      title: item.title,
      category: item.category,
      summary: item.summary,
      content_html: item.content_html,
      cover_url: item.cover_url,
      required_tier: item.required_tier,
      download_url: item.download_url || '',
      download_pwd: item.download_pwd || '',
      sort_order: item.sort_order,
      published: item.published,
    });
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.title.trim()) {
      setMessage({ type: 'error', text: '标题不能为空' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const payload: MallResourcePayload = {
      title: form.title.trim(),
      category: form.category,
      summary: form.summary,
      content_html: form.content_html,
      cover_url: form.cover_url,
      required_tier: form.required_tier,
      download_url: form.download_url || null,
      download_pwd: form.download_pwd || null,
      sort_order: form.sort_order,
      published: form.published,
    };
    try {
      if (form.id) {
        await platformApi.updateMallResource(appId, form.id, payload);
        setMessage({ type: 'success', text: '资源已更新' });
      } else {
        await platformApi.createMallResource(appId, payload);
        setMessage({ type: 'success', text: '资源已创建' });
      }
      setFormOpen(false);
      load();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: MallResourceItem) => {
    if (!window.confirm(`确认删除资源「${item.title}」？`)) return;
    try {
      await platformApi.deleteMallResource(appId, item.id);
      setMessage({ type: 'success', text: '已删除' });
      load();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除失败') });
    }
  };

  const checkLinks = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const r = await platformApi.checkMallResourceLinks(appId);
      setMessage({ type: 'success', text: `巡检完成：共 ${r.total} 条，新失效 ${r.invalid} 条，恢复 ${r.recovered} 条` });
      load();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '巡检失败') });
    } finally {
      setChecking(false);
    }
  };

  const catLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label || key;

  // 封面：canvas 压缩（长边 1600 / JPEG，自动降质到 ~500KB 内）后存服务器
  const uploadCover = async (file: File) => {
    setCoverUploading(true);
    setMessage(null);
    try {
      const { file: compressed, originalSize, compressedSize } = await compressImage(file, 1600, 0.82);
      const uploaded = await platformApi.uploadImageBuffer(compressed, 'xunlong', appId, 'mall/covers');
      setForm((prev) => ({ ...prev, cover_url: uploaded.file_url || '' }));
      setMessage({ type: 'success', text: `封面上传成功（${formatBytes(originalSize)} → ${formatBytes(compressedSize)}）` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '封面上传失败') });
    } finally {
      setCoverUploading(false);
      if (coverInputRef.current) coverInputRef.current.value = '';
    }
  };

  // 图文插图：压缩后上传到服务器，并在光标处插入 <img>（也可直接粘图床外链）
  const uploadInlineImage = async (file: File) => {
    setInlineUploading(true);
    setMessage(null);
    try {
      const { file: compressed, originalSize, compressedSize } = await compressImage(file, 1200, 0.8);
      const uploaded = await platformApi.uploadImageBuffer(compressed, 'xunlong', appId, 'mall/content');
      const url = uploaded.file_url || '';
      const imgTag = `<img src="${url}" style="max-width:100%;border-radius:8px" />`;
      setForm((prev) => {
        const el = document.getElementById('mall-content-html') as HTMLTextAreaElement | null;
        const pos = el ? el.selectionStart : prev.content_html.length;
        const next = prev.content_html.slice(0, pos) + '\n' + imgTag + '\n' + prev.content_html.slice(pos);
        return { ...prev, content_html: next };
      });
      setMessage({ type: 'success', text: `插图已插入（${formatBytes(originalSize)} → ${formatBytes(compressedSize)}）` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '插图上传失败') });
    } finally {
      setInlineUploading(false);
      if (inlineInputRef.current) inlineInputRef.current.value = '';
    }
  };

  return (
    <div style={{ padding: 20, color: '#e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#f9fafb' }}>商城资源库</h2>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>VIP 看介绍 / SVIP 拿下载链接；每天凌晨自动巡检链接有效性</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={checkLinks}
          disabled={checking || !items.length}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#e5e7eb', cursor: 'pointer' }}
        >
          {checking ? '巡检中...' : '立即巡检链接'}
        </button>
        <button
          onClick={openCreate}
          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
        >
          + 新建资源
        </button>
      </div>

      {message && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13,
          background: message.type === 'success' ? '#064e3b' : '#7f1d1d',
          color: message.type === 'success' ? '#6ee7b7' : '#fca5a5',
        }}>{message.text}</div>
      )}

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>加载中...</div>
      ) : !items.length ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: 24, border: '1px dashed #374151', borderRadius: 8, textAlign: 'center' }}>
          暂无资源，点击右上角「新建资源」添加第一份电子书/教材/指标
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => {
            const st = LINK_STATUS_MAP[item.link_status] || LINK_STATUS_MAP.unknown;
            return (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                background: '#111827', border: '1px solid #1f2937', borderRadius: 8, flexWrap: 'wrap',
              }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: '#f3f4f6', minWidth: 160 }}>{item.title}</span>
                <span style={{ fontSize: 11, color: '#9ca3af', background: '#1f2937', padding: '2px 8px', borderRadius: 10 }}>{catLabel(item.category)}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                  background: item.required_tier === 'SVIP' ? '#b8912a' : '#374151',
                  color: item.required_tier === 'SVIP' ? '#111827' : '#d1d5db',
                }}>{item.required_tier}</span>
                <span style={{ fontSize: 11, color: st.color }}>● {st.label}{item.link_fail_count > 0 ? `（失败${item.link_fail_count}次）` : ''}</span>
                {!item.published && <span style={{ fontSize: 11, color: '#d97706' }}>未发布</span>}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: '#6b7280' }}>{item.updated_at?.slice(0, 10)}</span>
                <button onClick={() => openEdit(item)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #4b5563', background: 'transparent', color: '#93c5fd', cursor: 'pointer', fontSize: 12 }}>编辑</button>
                <button onClick={() => remove(item)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #4b5563', background: 'transparent', color: '#fca5a5', cursor: 'pointer', fontSize: 12 }}>删除</button>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 100,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '40px 16px',
        }} onClick={(e) => { if (e.target === e.currentTarget) setFormOpen(false); }}>
          <div style={{ width: 640, maxWidth: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, color: '#f9fafb' }}>{form.id ? '编辑资源' : '新建资源'}</h3>

            <label style={labelStyle}>标题 *</label>
            <input style={inputStyle} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：2026 股海炼金术 全套课程" />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>分类</label>
                <select style={inputStyle} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>可见档位</label>
                <select style={inputStyle} value={form.required_tier} onChange={(e) => setForm({ ...form, required_tier: e.target.value as 'VIP' | 'SVIP' })}>
                  <option value="VIP">VIP（介绍可见，下载需 SVIP）</option>
                  <option value="SVIP">SVIP（整体仅 SVIP 可见）</option>
                </select>
              </div>
            </div>

            <label style={labelStyle}>简介</label>
            <input style={inputStyle} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="列表页展示的一句话简介" />

            <label style={labelStyle}>封面图（自动压缩后存服务器）</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {form.cover_url && (
                <img src={form.cover_url} alt="封面预览" style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 6, border: '1px solid #374151' }} />
              )}
              <input
                style={{ ...inputStyle, flex: 1, minWidth: 220 }}
                value={form.cover_url}
                onChange={(e) => setForm({ ...form, cover_url: e.target.value })}
                placeholder="上传或粘贴封面图地址"
              />
              <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); }}
              />
              <button
                type="button"
                onClick={() => coverInputRef.current?.click()}
                disabled={coverUploading}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#e5e7eb', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {coverUploading ? '压缩上传中...' : '上传封面'}
              </button>
            </div>

            <label style={labelStyle}>图文介绍（支持 HTML；插图走图床外链或上传，推荐外链节省服务器）</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <input
                ref={inlineInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadInlineImage(f); }}
              />
              <button
                type="button"
                onClick={() => inlineInputRef.current?.click()}
                disabled={inlineUploading}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#93c5fd', cursor: 'pointer', fontSize: 12 }}
              >
                {inlineUploading ? '压缩上传中...' : '📷 插入图片（压缩后存服务器）'}
              </button>
              <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>
                插入位置 = 光标处；图床图片直接把 &lt;img src="外链"&gt; 写进下方编辑器即可
              </span>
            </div>
            <textarea
              id="mall-content-html"
              style={{ ...inputStyle, minHeight: 120, fontFamily: 'monospace' }}
              value={form.content_html}
              onChange={(e) => setForm({ ...form, content_html: e.target.value })}
              placeholder={'<p>课程目录、截图等 HTML 内容</p>\n<img src="https://图床地址/xxx.jpg" style="max-width:100%" />'}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>网盘下载链接</label>
                <input style={inputStyle} value={form.download_url} onChange={(e) => setForm({ ...form, download_url: e.target.value })} placeholder="https://pan.baidu.com/s/xxxx" />
              </div>
              <div>
                <label style={labelStyle}>提取码</label>
                <input style={inputStyle} value={form.download_pwd} onChange={(e) => setForm({ ...form, download_pwd: e.target.value })} placeholder="选填" />
              </div>
            </div>
            {form.download_url && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                保存后每天凌晨 3:30 自动巡检该链接有效性，失效将进入通知中心告警
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div>
                <label style={labelStyle}>排序（越大越靠前）</label>
                <input style={inputStyle} type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={labelStyle}>发布状态</label>
                <select style={inputStyle} value={form.published ? '1' : '0'} onChange={(e) => setForm({ ...form, published: e.target.value === '1' })}>
                  <option value="1">发布</option>
                  <option value="0">下架</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setFormOpen(false)} style={{ padding: '8px 18px', borderRadius: 6, border: '1px solid #4b5563', background: 'transparent', color: '#9ca3af', cursor: 'pointer' }}>取消</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 22px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#9ca3af', margin: '12px 0 4px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #374151', background: '#0b0f19', color: '#e5e7eb', fontSize: 13,
};
