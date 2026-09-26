import { useEffect, useState } from 'react';
import { PlatformAiModelItem, PlatformAiModelSourceRouteItem, platformApi } from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type PriceVersion = { id: string; rates_json: Record<string, unknown> };

function parseBook(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) {
    throw new Error('价格规则必须是非空 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function initialBook(model: PlatformAiModelItem, kind: 'sell' | 'cost'): Record<string, unknown> {
  const rate = () => kind === 'sell' ? { rmb: 0, points: 0 } : { rmb: 0 };
  if (model.capability === 'chat' || model.capability === 'embedding') {
    return {
      input: rate(), cache_read: rate(), output: rate(),
    };
  }
  if (model.capability === 'video') {
    return { second: rate() };
  }
  if (model.capability === 'stt') {
    return { minute: rate() };
  }
  if (model.capability === 'tts' && model.pricing_mode === 'per_mchar') {
    return { character: rate() };
  }
  return { [model.capability === 'image' ? 'image' : 'call']: rate() };
}

export default function AiCommercialPricingPanel({ model, onClose, onChanged }: {
  model: PlatformAiModelItem;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [routes, setRoutes] = useState<PlatformAiModelSourceRouteItem[]>([]);
  const [sellBook, setSellBook] = useState('');
  const [costBooks, setCostBooks] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [routeResponse, sellResponse] = await Promise.all([
          platformApi.listGlobalAiModelSources(model.id),
          platformApi.getAiProductSellPrice(model.id),
        ]);
        const nextRoutes = pickApiData<{ items: PlatformAiModelSourceRouteItem[] }>(routeResponse)?.items || routeResponse.items || [];
        const sell = pickApiData<{ item: PriceVersion | null }>(sellResponse)?.item || sellResponse.item || null;
        const costs = await Promise.all(nextRoutes.map(async (route) => {
          if (!route.upstream_model_id) return [route.route_key || route.id || '', null] as const;
          const response = await platformApi.getAiUpstreamCostPrice(route.upstream_model_id);
          const cost = pickApiData<{ item: PriceVersion | null }>(response)?.item || response.item || null;
          return [route.route_key || route.id || '', cost?.rates_json || null] as const;
        }));
        if (!active) return;
        setRoutes(nextRoutes);
        setSellBook(sell ? JSON.stringify(sell.rates_json, null, 2) : '');
        setCostBooks(Object.fromEntries(costs.map(([key, book]) => [key, book ? JSON.stringify(book, null, 2) : ''])));
      } catch (error) {
        if (active) setMessage(pickApiErrorMessage(error, '价格加载失败'));
      }
    };
    void load();
    return () => { active = false; };
  }, [model]);

  const saveSell = async () => {
    setBusyKey('sell');
    setMessage('');
    try {
      await platformApi.saveAiProductSellPrice(model.id, parseBook(sellBook));
      setMessage('对外售价已启用');
      await onChanged();
    } catch (error) {
      setMessage(pickApiErrorMessage(error, '保存对外售价失败'));
    } finally {
      setBusyKey('');
    }
  };

  const saveCost = async (route: PlatformAiModelSourceRouteItem) => {
    const key = route.route_key || route.id || '';
    setBusyKey(key);
    setMessage('');
    try {
      const book = parseBook(costBooks[key] || '');
      let upstreamModelId = route.upstream_model_id || null;
      if (!upstreamModelId) {
        const response = await platformApi.upsertAiUpstreamCatalog({
          source_id: route.source_id,
          upstream_key: `${model.capability}:${route.upstream_model || model.upstream_model}`.slice(0, 96),
          upstream_model: route.upstream_model || model.upstream_model,
          capability: model.capability,
        });
        const upstream = pickApiData<{ id: string }>(response) || response;
        upstreamModelId = upstream.id;
      }
      await platformApi.saveAiUpstreamCostPrice(upstreamModelId, book);
      if (!route.upstream_model_id) {
        const nextRoutes = routes.map((item) => (item.route_key || item.id) === key
          ? { ...item, upstream_model_id: upstreamModelId }
          : item);
        await platformApi.replaceAiProductRoutes(model.id, nextRoutes);
        setRoutes(nextRoutes);
      }
      setMessage(`${route.source_name || route.source_id} 成本已启用`);
      await onChanged();
    } catch (error) {
      setMessage(pickApiErrorMessage(error, '保存上游成本失败'));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(event) => event.stopPropagation()}>
        <div className="card-header">
          <h3>{model.display_name || model.model_key} · 价格</h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>关闭</button>
        </div>
        <div className="form-group">
          <label>对外售价规则</label>
          <textarea rows={8} value={sellBook} onChange={(event) => setSellBook(event.target.value)} placeholder={JSON.stringify(initialBook(model, 'sell'), null, 2)} spellCheck={false} />
          <button type="button" className="btn btn-primary btn-sm" onClick={saveSell} disabled={!!busyKey || !sellBook}>保存并启用售价</button>
        </div>
        {routes.map((route) => {
          const key = route.route_key || route.id || '';
          return (
            <div className="form-group" key={key}>
              <label>{route.source_name || route.source_id} · {route.upstream_model || model.upstream_model} 成本规则</label>
              <textarea rows={7} value={costBooks[key] || ''} onChange={(event) => setCostBooks((current) => ({ ...current, [key]: event.target.value }))} placeholder={JSON.stringify(initialBook(model, 'cost'), null, 2)} spellCheck={false} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void saveCost(route)} disabled={!!busyKey || !costBooks[key]}>保存并启用成本</button>
            </div>
          );
        })}
        {message && <p role="status">{message}</p>}
      </div>
    </div>
  );
}
