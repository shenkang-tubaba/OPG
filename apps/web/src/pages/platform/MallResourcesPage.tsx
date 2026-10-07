import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  platformApi,
  type MallResourceItem,
  type MallResourcePayload,
  type MallTagItem,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';
import { compressImage, formatBytes } from '@/lib/image-compress';
import {
  extractPanLinks,
  extractImageUrls,
  buildImageTag,
  normalizeUrl,
  insertAtCursor,
  detectPanPlatform,
} from '@/lib/paste-parse';

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
  tags: string[];
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
  tags: [],
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
  // 标签管理
  const [tags, setTags] = useState<MallTagItem[]>([]);
  const [tagFilter, setTagFilter] = useState(''); // 按标签筛选列表
  const [newTagName, setNewTagName] = useState('');
  const [editingTag, setEditingTag] = useState<MallTagItem | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  const [tagInput, setTagInput] = useState(''); // 表单里的标签输入
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [searchText, setSearchText] = useState(''); // 列表搜索
  const [coverUploading, setCoverUploading] = useState(false);
  const [inlineUploading, setInlineUploading] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const contentAreaRef = useRef<HTMLTextAreaElement>(null);
  const [imgDialogOpen, setImgDialogOpen] = useState(false);
  const [imgDialogUrl, setImgDialogUrl] = useState('');
  const [imgDialogMsg, setImgDialogMsg] = useState<string | null>(null);
  const [panHint, setPanHint] = useState<{ label: string; pwd?: string | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const load = useCallback(async () => {
    if (!appId) return;
    setLoading(true);
    try {
      const [data, tagData] = await Promise.all([
        platformApi.listMallResources(appId),
        platformApi.listMallTags(appId).catch(() => ({ items: [] })),
      ]);
      setItems(data.items || []);
      setTags(tagData.items || []);
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
      tags: item.tags || [],
      download_url: item.download_url || '',
      download_pwd: item.download_pwd || '',
      sort_order: item.sort_order,
      published: item.published,
    });
    setTagInput('');
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
      tags: form.tags,
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

  // ===== 标签管理 =====
  const createTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      await platformApi.createMallTag(appId, name);
      setNewTagName('');
      load();
      setMessage({ type: 'success', text: `标签「${name}」已创建` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建标签失败') });
    }
  };

  const renameTag = async () => {
    if (!editingTag || !editingTagName.trim()) return;
    try {
      await platformApi.updateMallTag(appId, editingTag.id, editingTagName.trim());
      setEditingTag(null);
      load();
      setMessage({ type: 'success', text: `标签已改名为「${editingTagName.trim()}」，资源已同步` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '改名失败') });
    }
  };

  const removeTag = async (tag: MallTagItem) => {
    const tips = tag.usage_count > 0 ? `该标签被 ${tag.usage_count} 个资源使用，删除后会从这些资源中同步移除。` : '该标签暂未被使用。';
    if (!window.confirm(`确认删除标签「${tag.name}」？${tips}`)) return;
    try {
      await platformApi.deleteMallTag(appId, tag.id);
      if (tagFilter === tag.name) setTagFilter('');
      load();
      setMessage({ type: 'success', text: `标签「${tag.name}」已删除` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除标签失败') });
    }
  };

  // 表单内标签操作
  const addTagToForm = (name: string) => {
    const t = name.trim();
    if (!t) return;
    setForm((prev) => ({ ...prev, tags: prev.tags.includes(t) ? prev.tags : [...prev.tags, t].slice(0, 16) }));
    setTagInput('');
  };

  const removeTagFromForm = (name: string) => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== name) }));
  };

  // 列表按搜索词 + 标签过滤
  const filteredItems = items.filter((it) => {
    if (tagFilter && !(it.tags || []).includes(tagFilter)) return false;
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase();
      const hay = `${it.title} ${it.summary || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  // 图床链接弹窗：粘贴 → 自动规范化 → 插入光标处
  const openImgDialog = () => {
    // 预读剪贴板，有图片链接直接填入
    setImgDialogUrl('');
    setImgDialogMsg(null);
    setImgDialogOpen(true);
    navigator.clipboard?.readText?.().then((txt) => {
      const urls = extractImageUrls(txt);
      if (urls.length) {
        setImgDialogUrl(urls.join('\n'));
        setImgDialogMsg(`已从剪贴板识别到 ${urls.length} 个图片链接`);
      }
    }).catch(() => {});
  };

  const confirmInsertImages = () => {
    const raw = imgDialogUrl.trim();
    if (!raw) {
      setImgDialogMsg('请粘贴图片链接');
      return;
    }
    const normalized = raw.split(/\s+/).map(normalizeUrl).filter(Boolean);
    const urls = Array.from(new Set([...extractImageUrls(normalized.join('\n')), ...normalized.filter((u) => /^https?:\/\//i.test(u))]));
    if (!urls.length) {
      setImgDialogMsg('未识别到图片链接：请确认是 http(s) 开头的图片地址');
      return;
    }
    setForm((prev) => ({
      ...prev,
      content_html: insertAtCursor(contentAreaRef.current, prev.content_html, urls.map(buildImageTag).join('\n')),
    }));
    setImgDialogMsg(null);
    setImgDialogOpen(false);
    setMessage({ type: 'success', text: `已插入 ${urls.length} 张图床图片（自动规范化）` });
  };

  // 网盘链接粘贴自动识别：平台 + 提取码
  const handleDownloadUrlChange = (value: string) => {
    setForm((prev) => ({ ...prev, download_url: value }));
    const text = value;
    const links = extractPanLinks(text);
    if (links.length) {
      const first = links[0];
      setForm((prev) => ({
        ...prev,
        download_url: first.url,
        download_pwd: first.pwd || prev.download_pwd,
      }));
      setPanHint({ label: first.platformLabel, pwd: first.pwd });
      return;
    }
    // 单链接无平台命中：仍尝试从整段文本抠提取码
    const hit = detectPanPlatform(normalizeUrl(text));
    if (hit) {
      setForm((prev) => ({ ...prev, download_url: normalizeUrl(text) }));
      setPanHint({ label: hit.label });
      return;
    }
    const pwdMatch = /(?:提取码|访问码|密码)\s*[:：=]?\s*([a-zA-Z0-9]{3,8})/i.exec(text);
    if (pwdMatch && !links.length) {
      setForm((prev) => ({ ...prev, download_pwd: prev.download_pwd || pwdMatch[1] }));
      setPanHint({ label: '已识别提取码（平台未识别）', pwd: pwdMatch[1] });
      return;
    }
    setPanHint(null);
  };

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
      setForm((prev) => ({
        ...prev,
        content_html: insertAtCursor(contentAreaRef.current, prev.content_html, imgTag),
      }));
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
        <span style={{ fontSize: 12, color: '#9ca3af' }}>资料预览对所有人开放；普通资料 VIP 可下载，高级资料仅 SVIP 可下载；每天凌晨自动巡检链接</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setManageTagsOpen((v) => !v)}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#e8b34b', cursor: 'pointer' }}
        >
          🏷 标签管理{tags.length ? `（${tags.length}）` : ''} {manageTagsOpen ? '▲' : '▼'}
        </button>
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

      {/* 搜索框 */}
      <input
        style={{ ...inputStyle, width: 260, marginBottom: 12 }}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="🔍 搜索标题/简介/标签"
      />

      {/* 标签管理面板 */}
      {manageTagsOpen && (
        <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input
              style={{ ...inputStyle, width: 200 }}
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTag(); }}
              placeholder="新标签名，如：股票讲座、基金、量学云讲堂"
            />
            <button onClick={createTag} disabled={!newTagName.trim()} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: newTagName.trim() ? 'pointer' : 'not-allowed', fontSize: 12 }}>+ 新建</button>
            <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>改名会同步更新所有使用该标签的资源；删除会从资源中移除</span>
          </div>
          {!tags.length ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>暂无标签，新建后可在资源表单中勾选</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {tags.map((t) => (
                <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#1f2937', border: '1px solid #374151', borderRadius: 14, padding: '4px 10px', fontSize: 12, color: '#d1d5db' }}>
                  {editingTag?.id === t.id ? (
                    <>
                      <input
                        autoFocus
                        value={editingTagName}
                        onChange={(e) => setEditingTagName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') renameTag(); if (e.key === 'Escape') setEditingTag(null); }}
                        style={{ width: 110, background: '#0b0f19', border: '1px solid #4b5563', borderRadius: 4, color: '#e5e7eb', fontSize: 12, padding: '2px 6px' }}
                      />
                      <button onClick={renameTag} style={{ background: 'none', border: 'none', color: '#4ade80', cursor: 'pointer', fontSize: 11 }}>✓</button>
                      <button onClick={() => setEditingTag(null)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 11 }}>✕</button>
                    </>
                  ) : (
                    <>
                      <span
                        onClick={() => setTagFilter(tagFilter === t.name ? '' : t.name)}
                        style={{ cursor: 'pointer', color: tagFilter === t.name ? '#e8b34b' : '#d1d5db', fontWeight: tagFilter === t.name ? 700 : 400 }}
                        title="点击筛选该标签的资源"
                      >{t.name}{t.usage_count > 0 ? ` (${t.usage_count})` : ''}</span>
                      <button onClick={() => { setEditingTag(t); setEditingTagName(t.name); }} style={{ background: 'rgba(147,197,253,.15)', border: '1px solid #4b5563', color: '#93c5fd', cursor: 'pointer', fontSize: 10, padding: '1px 6px', borderRadius: 4 }} title="改名">改名</button>
                      <button onClick={() => removeTag(t)} style={{ background: 'rgba(252,165,165,.12)', border: '1px solid #7f1d1d', color: '#fca5a5', cursor: 'pointer', fontSize: 10, padding: '1px 6px', borderRadius: 4 }} title="删除">删除</button>
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 标签筛选条（收起管理面板时也可见） */}
      {!manageTagsOpen && tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#6b7280' }}>按标签筛选：</span>
          <span
            onClick={() => setTagFilter('')}
            style={{ cursor: 'pointer', fontSize: 11, padding: '3px 10px', borderRadius: 12, border: '1px solid #374151', color: tagFilter ? '#9ca3af' : '#e8b34b', fontWeight: tagFilter ? 400 : 700, background: tagFilter ? 'transparent' : 'rgba(232,179,75,.1)' }}
          >全部</span>
          {tags.map((t) => (
            <span
              key={t.id}
              onClick={() => setTagFilter(tagFilter === t.name ? '' : t.name)}
              style={{ cursor: 'pointer', fontSize: 11, padding: '3px 10px', borderRadius: 12, border: '1px solid #374151', background: tagFilter === t.name ? 'rgba(232,179,75,.12)' : 'transparent', color: tagFilter === t.name ? '#e8b34b' : '#9ca3af', fontWeight: tagFilter === t.name ? 700 : 400 }}
            >{t.name}{t.usage_count > 0 ? ` (${t.usage_count})` : ''}</span>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>加载中...</div>
      ) : !filteredItems.length ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: 24, border: '1px dashed #374151', borderRadius: 8, textAlign: 'center' }}>
          {items.length ? '没有符合标签筛选的资源' : '暂无资源，点击右上角「新建资源」添加第一份电子书/教材/指标'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filteredItems.map((item) => {
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
                }}                >{item.required_tier === 'SVIP' ? '高级' : '普通'}</span>
                {(item.tags || []).map((t) => (
                  <span key={t} style={{ fontSize: 11, color: '#93c5fd', background: 'rgba(59,130,246,.1)', padding: '2px 8px', borderRadius: 10 }}>{t}</span>
                ))}
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
                  <option value="VIP">普通资料（预览开放，VIP 及以上可下载）</option>
                  <option value="SVIP">高级资料（预览开放，仅 SVIP 可下载）</option>
                </select>
              </div>
            </div>

            <label style={labelStyle}>资料标签（可多选，方便用户筛选）</label>
            {/* 已选标签 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {form.tags.map((t) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 10px', borderRadius: 12, background: 'rgba(59,130,246,.12)', color: '#93c5fd', border: '1px solid rgba(59,130,246,.3)' }}>
                  {t}
                  <button type="button" onClick={() => removeTagFromForm(t)} style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 11, padding: 0 }}>✕</button>
                </span>
              ))}
              {!form.tags.length && <span style={{ fontSize: 11, color: '#6b7280' }}>未选标签——点下面已有标签即可勾选</span>}
            </div>
            {/* 已建标签：全部平铺点选（勾选高亮），带过滤输入 */}
            {tags.length > 0 && (
              <div style={{ background: '#0b0f19', border: '1px solid #23272f', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                  <input
                    style={{ ...inputStyle, width: 150, padding: '4px 8px', fontSize: 11 }}
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="🔎 过滤已有标签…"
                  />
                  <span style={{ fontSize: 10, color: '#6b7280' }}>点击切换选中状态</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {tags
                    .filter((t) => !tagInput.trim() || t.name.toLowerCase().includes(tagInput.trim().toLowerCase()))
                    .map((t) => {
                      const selected = form.tags.includes(t.name);
                      return (
                        <button
                          key={t.id} type="button"
                          onClick={() => (selected ? removeTagFromForm(t.name) : addTagToForm(t.name))}
                          style={{
                            padding: '4px 12px', borderRadius: 14, fontSize: 12, cursor: 'pointer',
                            border: selected ? '1px solid #2f6fed' : '1px dashed #4b5563',
                            background: selected ? '#2f6fed' : 'transparent',
                            color: selected ? '#fff' : '#9ca3af',
                            fontWeight: selected ? 600 : 400,
                          }}
                        >{selected ? '✓ ' : '+ '}{t.name}</button>
                      );
                    })}
                </div>
                {!tags.filter((t) => !tagInput.trim() || t.name.toLowerCase().includes(tagInput.trim().toLowerCase())).length && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                    没有匹配的标签——回车上方输入框即可创建新标签「{tagInput.trim()}」
                  </div>
                )}
              </div>
            )}
            {/* 自由新建（不在已有标签里的） */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                style={{ ...inputStyle, width: 200, padding: '5px 8px', fontSize: 12 }}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const t = tagInput.trim();
                    if (t && !form.tags.includes(t)) {
                      addTagToForm(t);
                      // 同时入标签库，方便下次复用
                      platformApi.createMallTag(appId, t).catch(() => {}).then(() => load());
                    }
                  }
                }}
                placeholder="没有想要的标签？输入后回车（自动入库）"
              />
              <span style={{ fontSize: 10, color: '#6b7280' }}>新标签会自动存入标签库</span>
            </div>

            <label style={labelStyle}>简介</label>
            <input style={inputStyle} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="列表页展示的一句话简介" />

            <label style={labelStyle}>封面图（自动压缩后存服务器）</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {form.cover_url && (
                <img
                  src={form.cover_url}
                  alt="封面预览"
                  style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 6, border: '1px solid #374151', background: '#10131a' }}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.style.opacity = '0.2';
                    img.style.outline = '1px dashed #dc2626';
                    img.title = '封面地址暂时无法加载（部署 v0.3.11 后自动恢复），不影响保存';
                  }}
                  onLoad={(e) => { const img = e.target as HTMLImageElement; img.style.opacity = '1'; img.style.outline = 'none'; }}
                />
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

            <label style={labelStyle}>图文介绍（支持 HTML；推荐图床外链，或上传压缩图）</label>
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
                {inlineUploading ? '压缩上传中...' : '📷 上传插图'}
              </button>
              <button
                type="button"
                onClick={openImgDialog}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#6ee7b7', cursor: 'pointer', fontSize: 12 }}
              >
                🌐 插入图床图片
              </button>
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                disabled={!form.content_html.trim()}
                title={form.content_html.trim() ? '按 App 端样式预览' : '先填写图文内容'}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #4b5563', background: '#1f2937', color: '#e8b34b', cursor: form.content_html.trim() ? 'pointer' : 'not-allowed', fontSize: 12, opacity: form.content_html.trim() ? 1 : 0.5 }}
              >
                👁 预览
              </button>
              <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>
                插入位置 = 光标处；链接自动规范化，不怕贴错格式
              </span>
            </div>
            <textarea
              ref={contentAreaRef}
              style={{ ...inputStyle, minHeight: 120, fontFamily: 'monospace' }}
              value={form.content_html}
              onChange={(e) => setForm({ ...form, content_html: e.target.value })}
              placeholder={'<p>课程目录、截图等 HTML 内容</p>'}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>网盘下载链接（粘贴分享文本自动识别平台/提取码）</label>
                <input
                  style={inputStyle}
                  value={form.download_url}
                  onChange={(e) => handleDownloadUrlChange(e.target.value)}
                  placeholder="粘贴网盘链接或整段分享文本"
                />
                {panHint && (
                  <div style={{ fontSize: 11, color: '#6ee7b7', marginTop: 4 }}>
                    ✓ 已识别：{panHint.label}{panHint.pwd ? `，提取码 ${panHint.pwd}` : ''}
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>提取码</label>
                <input style={inputStyle} value={form.download_pwd} onChange={(e) => setForm({ ...form, download_pwd: e.target.value })} placeholder="选填；粘贴文本可自动填" />
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

            {/* 图床链接弹窗 */}
            {imgDialogOpen && (
              <div style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 200,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
              }} onClick={(e) => { if (e.target === e.currentTarget) setImgDialogOpen(false); }}>
                <div style={{ width: 480, maxWidth: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: 20 }}>
                  <h4 style={{ margin: '0 0 10px', fontSize: 15, color: '#f9fafb' }}>插入图床图片</h4>
                  <p style={{ margin: '0 0 10px', fontSize: 12, color: '#9ca3af' }}>
                    粘贴图片链接（支持多行/整段文本自动抽取），自动规范化后插入光标处。已自动读取剪贴板。
                  </p>
                  <textarea
                    autoFocus
                    style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace' }}
                    value={imgDialogUrl}
                    onChange={(e) => setImgDialogUrl(e.target.value)}
                    placeholder={'https://i.imgur.com/abc.jpg\nhttps://cdn.example.com/pic.png'}
                  />
                  {imgDialogMsg && <div style={{ fontSize: 12, color: '#93c5fd', marginTop: 6 }}>{imgDialogMsg}</div>}
                  <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
                    <button onClick={() => setImgDialogOpen(false)} style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #4b5563', background: 'transparent', color: '#9ca3af', cursor: 'pointer' }}>取消</button>
                    <button onClick={confirmInsertImages} style={{ padding: '6px 20px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>插入</button>
                  </div>
                </div>
              </div>
            )}

            {/* App 端样式预览弹窗 */}
            {previewOpen && (
              <div style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 210,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
              }} onClick={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false); }}>
                <div style={{ width: 380, maxWidth: '100%', maxHeight: '86vh', overflowY: 'auto', background: '#171a21', borderRadius: 18, padding: 16, border: '1px solid #2c313c' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e8eaf0' }}>📱 App 端预览</span>
                    <button onClick={() => setPreviewOpen(false)} style={{ background: 'none', border: 'none', color: '#9aa0ae', fontSize: 16, cursor: 'pointer' }}>✕</button>
                  </div>
                  {/* 封面 */}
                  {form.cover_url && (
                    <img src={form.cover_url} alt="封面" style={{ width: '100%', height: 170, objectFit: 'cover', borderRadius: 12, marginBottom: 12, display: 'block', background: '#10131a' }} onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.25'; }} />
                  )}
                  {/* 标题/分类/简介 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#f3f4f6', flex: 1, minWidth: 0, overflowWrap: 'break-word' }}>{form.title || '（未填标题）'}</span>
                    <span style={{ fontSize: 10, color: '#9aa0ae', background: '#1c1f26', padding: '2px 8px', borderRadius: 8 }}>{CATEGORIES.find(c => c.key === form.category)?.label || form.category}</span>
                    {form.required_tier === 'SVIP' && <span style={{ fontSize: 10, fontWeight: 700, color: '#e8b34b', background: 'rgba(232,179,75,.12)', padding: '2px 8px', borderRadius: 8 }}>SVIP</span>}
                  </div>
                  {(form.tags || []).length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                      {form.tags.map((t) => <span key={t} style={{ fontSize: 10, color: '#93c5fd', background: 'rgba(59,130,246,.12)', padding: '2px 8px', borderRadius: 8 }}>{t}</span>)}
                    </div>
                  )}
                  {form.summary && <div style={{ fontSize: 12, color: '#9aa0ae', marginBottom: 10, lineHeight: 1.6 }}>{form.summary}</div>}
                  {/* 图文：模拟 App 深色卡片渲染 */}
                  <div
                    style={{
                      background: '#10131a', border: '1px solid #23272f', borderRadius: 10,
                      padding: 12, fontSize: 13, lineHeight: 1.7, color: '#c8ccd4', overflowWrap: 'break-word',
                    }}
                    className="mall-content-preview"
                    dangerouslySetInnerHTML={{ __html: APP_PREVIEW_CSS + (form.content_html || '<span style="color:#6b7280">（无图文内容）</span>') }}
                  />
                  {/* 下载区（与 App 端一致：单个复制按钮） */}
                  <div style={{ background: '#10131a', border: '1px solid #23272f', borderRadius: 10, padding: 12, marginTop: 10 }}>
                    {form.download_url ? (
                      <>
                        {form.download_pwd && <div style={{ fontSize: 12, color: '#9aa0ae', marginBottom: 8 }}>提取码：<b style={{ color: '#e8eaf0' }}>{form.download_pwd}</b></div>}
                        <div style={{ textAlign: 'center', padding: '9px 0', borderRadius: 8, background: '#2f6fed', color: '#fff', fontSize: 13, fontWeight: 600 }}>📋 复制链接和提取码</div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center' }}>🔒 会员专享下载链接，开通会员解锁（未填链接时 App 端显示此文案）</div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#4b5563', textAlign: 'center', marginTop: 10 }}>预览仅供排版参考，实际以 App 渲染为准</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#9ca3af', margin: '12px 0 4px',
};

/** 注入预览容器的样式：让 h1-h4/p/ul/img 等按 App 深色风格渲染（dangerouslySetInnerHTML 不吃 scoped CSS） */
const APP_PREVIEW_CSS = `<style>
.mall-content-preview h1,.mall-content-preview h2,.mall-content-preview h3,.mall-content-preview h4{color:#e8eaf0;margin:10px 0 6px;font-size:14px}
.mall-content-preview p{margin:6px 0}
.mall-content-preview ul,.mall-content-preview ol{margin:6px 0;padding-left:20px}
.mall-content-preview li{margin:3px 0}
.mall-content-preview img{max-width:100%;height:auto;border-radius:8px;margin:8px 0;display:block}
.mall-content-preview a{color:#93c5fd}
.mall-content-preview table{border-collapse:collapse;width:100%}
.mall-content-preview td,.mall-content-preview th{border:1px solid #2c313c;padding:4px 8px;font-size:12px}
.mall-content-preview strong{color:#e8eaf0}
</style>`;
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #374151', background: '#0b0f19', color: '#e5e7eb', fontSize: 13,
};
