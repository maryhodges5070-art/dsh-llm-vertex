/**
 * Client half of the Vertex AI bundle: a dedicated "Vertex AI" page inside the
 * Harness settings dialog, backed by the host routes under /vertex-api.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-vertex',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/vertex-api';

    const LOCATIONS = [
      'global',
      'us-central1',
      'us-east1',
      'us-west1',
      'europe-west4',
      'asia-northeast1',
      'asia-southeast1',
    ];

    const CONTEXT_WINDOWS = [
      { value: 200000, zh: '200K（200,000 tokens · 标准计费档）', en: '200K (200,000 tokens · standard pricing tier)' },
      { value: 512000, zh: '512K（512,000 tokens）', en: '512K (512,000 tokens)' },
      { value: 1048576, zh: '1M（1,048,576 tokens · 默认完整窗口）', en: '1M (1,048,576 tokens · full window, default)' },
    ];

    const zh = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh');
    const T = zh
      ? {
          title: 'Vertex AI',
          subtitle: '通过 Google Cloud 凭证（ADC 或服务账号 JSON）调用 Gemini 模型。',
          project: '项目 ID',
          projectHint: '留空则使用凭证里的 quota_project_id 或 gcloud 默认项目。',
          location: '区域',
          locationHint: 'Gemini 3 系列目前只在 global 可用。',
          credential: '凭证 JSON 路径',
          credentialHint: '留空则使用 GOOGLE_APPLICATION_CREDENTIALS 或 gcloud ADC 默认路径。',
          proxy: '代理（可选）',
          proxyHint: '如 http://127.0.0.1:7890、https://user:pass@host:8080 或 socks5://user:pass@host:1080；留空则直连。',
          rpm: '每分钟请求上限',
          rpmHint: '滑动一分钟窗口，超出即本地排队，不会外发。',
          concurrency: '并发上限',
          concurrencyHint: '同时在途的请求数，其余在本地排队。',
          contextWindow: '上下文长度上限',
          contextWindowHint: '限制单次会话上下文窗口（200K 可避免触发 Google >200K 高阶计费，超出自动压缩）。',
          save: '保存',
          saving: '保存中…',
          test: '测试连接',
          testing: '测试中…',
          login: '用 gcloud 登录',
          refresh: '刷新',
          status: '状态',
          credentialKind: '凭证类型',
          effectiveProject: '生效项目',
          token: '访问令牌',
          tokenCached: (s) => `有效，剩余 ${s}`,
          tokenNone: '尚未获取（首次调用时获取）',
          models: '可用模型',
          modelListTitle: '模型清单',
          modelListHint: '模型按区域提供；“获取可用模型”会实时向 Vertex 查询。',
          fetchModels: '获取可用模型',
          fetching: '正在查询…',
          modelListEmpty: '该区域没有返回可用的 Gemini 模型。',
          modelCount: (n) => `共 ${n} 个 Gemini 模型`,
          addModel: '添加',
          removeModel: '移除',
          testModel: '测试',
          testingModel: '测试中…',
          inList: '已在清单中',
          modelsSaved: '模型清单已保存，插件已重载。',
          noCredential: '未找到凭证文件',
          saved: '已保存，插件已按新配置重载。',
          tested: (model, ms, answer) => `${model} 响应正常（${ms} ms）：${answer}`,
          loginStarted: '已启动浏览器登录，完成后点“刷新”。',
          loginFailed: (msg) => `无法启动 gcloud：${msg}`,
          loginPending: 'gcloud 登录进行中…',
          error: '出错',
          loadFailed: '无法读取插件状态，请确认 Web 服务可用。',
        }
      : {
          title: 'Vertex AI',
          subtitle: 'Call Gemini models through a Google Cloud credential (ADC or a service-account JSON).',
          project: 'Project ID',
          projectHint: 'Empty falls back to quota_project_id in the credential, then gcloud config.',
          location: 'Location',
          locationHint: 'The Gemini 3 family is currently served from global only.',
          credential: 'Credential JSON path',
          credentialHint: 'Empty falls back to GOOGLE_APPLICATION_CREDENTIALS or the gcloud ADC path.',
          proxy: 'Proxy (optional)',
          proxyHint: 'e.g. http://127.0.0.1:7890, https://user:pass@host:8080 or socks5://user:pass@host:1080; empty means direct.',
          rpm: 'Requests per minute',
          rpmHint: 'Sliding one-minute window; extra calls queue locally instead of being sent.',
          concurrency: 'Max concurrency',
          concurrencyHint: 'Requests allowed in flight at once; the rest wait locally.',
          contextWindow: 'Context window limit',
          contextWindowHint: 'Cap the model context window (200K avoids Google >200K tiered pricing and triggers auto-compaction earlier).',
          save: 'Save',
          saving: 'Saving…',
          test: 'Test connection',
          testing: 'Testing…',
          login: 'Sign in with gcloud',
          refresh: 'Refresh',
          status: 'Status',
          credentialKind: 'Credential',
          effectiveProject: 'Effective project',
          token: 'Access token',
          tokenCached: (s) => `valid, ${s} left`,
          tokenNone: 'not fetched yet (fetched on the first call)',
          models: 'Models',
          modelListTitle: 'Model catalogue',
          modelListHint: 'Models are served per location; “List available models” asks Vertex live.',
          fetchModels: 'List available models',
          fetching: 'Querying…',
          modelListEmpty: 'This location returned no Gemini models.',
          modelCount: (n) => `${n} Gemini models`,
          addModel: 'Add',
          removeModel: 'Remove',
          testModel: 'Test',
          testingModel: 'Testing…',
          inList: 'in the list',
          modelsSaved: 'Model list saved; the plugin reloaded.',
          noCredential: 'credential file not found',
          saved: 'Saved; the plugin reloaded with the new configuration.',
          tested: (model, ms, answer) => `${model} answered in ${ms} ms: ${answer}`,
          loginStarted: 'Browser sign-in started; click Refresh when it finishes.',
          loginFailed: (msg) => `Could not start gcloud: ${msg}`,
          loginPending: 'gcloud sign-in in progress…',
          error: 'Error',
          loadFailed: 'Could not read plugin state; check that the Web server is running.',
        };

    const css = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        maxWidth: '760px',
        padding: '4px 2px 24px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.55,
      },
      header: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '18px', fontWeight: 600, margin: 0 },
      subtitle: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontWeight: 600, fontSize: '12px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
      rowItem: { flex: '1 1 220px', minWidth: '200px' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '6px 14px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontWeight: 600,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: '11.5px',
      },
      kv: { display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr', gap: '6px 14px' },
      k: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      v: { wordBreak: 'break-all', fontSize: '12px' },
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      modelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        paddingTop: '8px',
      },
      mini: {
        padding: '3px 10px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      message: {
        padding: '8px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: '12.5px',
        wordBreak: 'break-word',
      },
    };

    /**
     * @param {number} ms - remaining lifetime.
     * @returns {string} a short human duration.
     */
    function duration(ms) {
      const minutes = Math.max(0, Math.round(ms / 60000));
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    }

    let csrfToken = '';

    /**
     * @param {string} route - API sub-path.
     * @param {object} [init] - fetch options.
     * @returns {Promise<any>} parsed JSON, throwing on failure.
     */
    async function call(route, init) {
      const method = (init?.method || 'GET').toUpperCase();
      const extraHeaders = method === 'POST'
        ? {
            'x-vertex-admin': '1',
            ...(csrfToken ? { 'x-vertex-csrf': csrfToken } : {}),
          }
        : {};
      const response = await fetch(`${API}${route}`, {
        credentials: 'same-origin',
        ...(init ?? {}),
        headers: {
          ...extraHeaders,
          ...(init?.headers ?? {}),
        },
      });
      const text = await response.text();
      let payload;
      try {
        payload = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        payload = { ok: false, error: text.slice(0, 400) };
      }
      if (typeof payload?.csrfToken === 'string' && payload.csrfToken.length > 0) {
        csrfToken = payload.csrfToken;
      }
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || `HTTP ${response.status}`);
        error.code = payload.code || `HTTP_${response.status}`;
        throw error;
      }
      return payload;
    }

    function VertexSettings() {
      const [state, setState] = React.useState(null);
      const [loadError, setLoadError] = React.useState('');
      const [draft, setDraft] = React.useState({ projectId: '', location: 'global', contextWindow: 1048576, credentialPath: '', proxyUrl: '', requestsPerMinute: 60, maxConcurrent: 4, models: [] });
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const [loginPending, setLoginPending] = React.useState(false);
      const [available, setAvailable] = React.useState(null);
      const [modelBusy, setModelBusy] = React.useState('');

      const apply = React.useCallback((next) => {
        setState(next);
        setLoadError('');
        setDraft({
          projectId: next.config.projectId || '',
          location: next.config.location || 'global',
          contextWindow: next.config.contextWindow || 1048576,
          credentialPath: next.config.credentialPath || '',
          proxyUrl: next.config.proxyUrl || '',
          requestsPerMinute: next.config.requestsPerMinute || 60,
          maxConcurrent: next.config.maxConcurrent || 4,
          models: (next.config.models || []).map((model) => model.id),
        });
      }, []);

      const reload = React.useCallback(async () => {
        try {
          apply(await call('/state'));
        } catch (error) {
          setLoadError(error.message || T.loadFailed);
        }
      }, [apply]);

      React.useEffect(() => {
        void reload();
      }, [reload]);

      React.useEffect(() => {
        if (!loginPending) return undefined;
        const timer = setInterval(() => {
          void call('/state')
            .then((next) => {
              apply(next);
              if (next.token?.cached) {
                setLoginPending(false);
                setMessage({ tone: 'ok', text: T.saved });
              }
            })
            .catch(() => {});
        }, 3000);
        return () => clearInterval(timer);
      }, [loginPending, apply]);

      const save = async () => {
        setBusy('save');
        setMessage(null);
        try {
          await call('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          setMessage({ tone: 'ok', text: T.saved });
          await reload();
        } catch (error) {
          setMessage({ tone: 'error', text: `${T.error}: ${error.message}` });
        } finally {
          setBusy('');
        }
      };

      const test = async () => {
        setBusy('test');
        setMessage(null);
        try {
          const result = await call('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setMessage({ tone: 'ok', text: T.tested(result.model, result.ms, result.answer || '—') });
          await reload();
        } catch (error) {
          setMessage({ tone: 'error', text: `${T.error}: ${error.message}` });
        } finally {
          setBusy('');
        }
      };

      const login = async () => {
        setBusy('login');
        setMessage(null);
        try {
          const result = await call('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (result.ok) {
            setLoginPending(true);
            setMessage({ tone: 'ok', text: T.loginStarted });
          } else {
            setMessage({ tone: 'error', text: T.loginFailed(result.error || result.command) });
          }
        } catch (error) {
          setMessage({ tone: 'error', text: T.loginFailed(error.message) });
        } finally {
          setBusy('');
        }
      };

      const loadModels = async () => {
        setModelBusy('fetch');
        setMessage(null);
        try {
          const result = await call('/models');
          const list = result.models || [];
          setAvailable(list);
          setMessage({ tone: 'ok', text: T.modelCount(result.count ?? list.length) });
        } catch (error) {
          setMessage({ tone: 'error', text: `${T.error}: ${error.message}` });
        } finally {
          setModelBusy('');
        }
      };

      const toggleModel = (id) => {
        setDraft((current) => ({
          ...current,
          models: current.models.includes(id)
            ? current.models.filter((model) => model !== id)
            : [...current.models, id],
        }));
      };

      const testModel = async (id) => {
        setModelBusy(id);
        setMessage(null);
        try {
          const result = await call('/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: id }),
          });
          setMessage({ tone: 'ok', text: T.tested(result.model, result.ms, result.answer || '—') });
        } catch (error) {
          setMessage({ tone: 'error', text: `${id}: ${error.message}` });
        } finally {
          setModelBusy('');
        }
      };

      const saveModels = async () => {
        setModelBusy('save');
        setMessage(null);
        try {
          await call('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          setMessage({ tone: 'ok', text: T.modelsSaved });
          setAvailable(null);
          await reload();
        } catch (error) {
          setMessage({ tone: 'error', text: `${T.error}: ${error.message}` });
        } finally {
          setModelBusy('');
        }
      };

      const header = h(
        'div',
        { style: css.header },
        h('h2', { style: css.title }, T.title),
        state?.token?.cached
          ? h('span', { style: { ...css.pill, color: 'var(--dsw-alias-state-success-primary)' } }, T.tokenCached(duration(state.token.expiresInMs)))
          : h('span', { style: { ...css.pill, color: 'var(--dsw-alias-label-secondary)' } }, T.tokenNone),
      );

      if (loadError && state === null) {
        return h(
          'div',
          { style: css.page },
          header,
          h('div', { style: { ...css.message, color: 'var(--dsw-alias-state-error-primary)' } }, loadError),
        );
      }

      const credential = state?.credential;
      const fields = h(
        'div',
        { style: css.card },
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('label', { style: css.label }, T.project),
            h('input', {
              style: css.input,
              value: draft.projectId,
              placeholder: state?.effective?.projectId || '',
              onChange: (event) => setDraft({ ...draft, projectId: event.target.value }),
            }),
            h('span', { style: css.hint }, T.projectHint),
          ),
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('label', { style: css.label }, T.location),
            h(
              'select',
              {
                style: { ...css.input, cursor: 'pointer' },
                value: draft.location,
                onChange: (event) => setDraft({ ...draft, location: event.target.value }),
              },
              LOCATIONS.map((location) => h('option', { key: location, value: location }, location)),
            ),
            h('span', { style: css.hint }, T.locationHint),
          ),
        ),
        h(
          'div',
          { style: css.field },
          h('label', { style: css.label }, T.credential),
          h('input', {
            style: css.input,
            value: draft.credentialPath,
            placeholder: state?.defaults?.credentialPath || (state?.defaults?.credentialExists ? 'default ADC (found)' : 'default ADC'),
            onChange: (event) => setDraft({ ...draft, credentialPath: event.target.value }),
          }),
          h('span', { style: css.hint }, T.credentialHint),
        ),
        h(
          'div',
          { style: css.field },
          h('label', { style: css.label }, T.proxy),
          h('input', {
            style: css.input,
            value: draft.proxyUrl,
            placeholder: 'http://127.0.0.1:7890',
            onChange: (event) => setDraft({ ...draft, proxyUrl: event.target.value }),
          }),
          h('span', { style: css.hint }, T.proxyHint),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('label', { style: css.label }, T.rpm),
            h('input', {
              style: css.input,
              type: 'number',
              min: 1,
              value: draft.requestsPerMinute,
              onChange: (event) => setDraft({ ...draft, requestsPerMinute: Number(event.target.value) }),
            }),
            h('span', { style: css.hint }, T.rpmHint),
          ),
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('label', { style: css.label }, T.concurrency),
            h('input', {
              style: css.input,
              type: 'number',
              min: 1,
              value: draft.maxConcurrent,
              onChange: (event) => setDraft({ ...draft, maxConcurrent: Number(event.target.value) }),
            }),
            h('span', { style: css.hint }, T.concurrencyHint),
          ),
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('label', { style: css.label }, T.contextWindow),
            h(
              'select',
              {
                style: { ...css.input, cursor: 'pointer' },
                value: String(draft.contextWindow || 1048576),
                onChange: (event) => setDraft({ ...draft, contextWindow: Number(event.target.value) }),
              },
              CONTEXT_WINDOWS.map((option) =>
                h('option', { key: option.value, value: String(option.value) }, zh ? option.zh : option.en),
              ),
            ),
            h('span', { style: css.hint }, T.contextWindowHint),
          ),
        ),
        h(
          'div',
          { style: css.actions },
          h(
            'button',
            { style: { ...css.button, ...css.primary }, disabled: busy !== '', onClick: save },
            busy === 'save' ? T.saving : T.save,
          ),
          h(
            'button',
            { style: css.button, disabled: busy !== '', onClick: test },
            busy === 'test' ? T.testing : T.test,
          ),
          h(
            'button',
            { style: css.button, disabled: busy !== '', onClick: login },
            busy === 'login' ? T.loginPending : T.login,
          ),
          h('button', { style: css.button, disabled: busy !== '', onClick: reload }, T.refresh),
        ),
      );

      const modelCard = h(
        'div',
        { style: css.card },
        h(
          'div',
          { style: css.row },
          h(
            'div',
            { style: { ...css.field, ...css.rowItem } },
            h('span', { style: css.label }, T.modelListTitle),
            h(
              'div',
              { style: css.chips },
              draft.models.length === 0
                ? h('span', { style: css.hint }, '—')
                : draft.models.map((id) => h('span', { key: id, style: { ...css.pill, ...css.mono } }, id)),
            ),
            h('span', { style: css.hint }, T.modelListHint),
          ),
          h(
            'div',
            { style: { ...css.actions, alignSelf: 'flex-end' } },
            h(
              'button',
              { style: { ...css.button, ...css.primary }, disabled: modelBusy !== '' || busy !== '', onClick: loadModels },
              modelBusy === 'fetch' ? T.fetching : T.fetchModels,
            ),
            h(
              'button',
              { style: css.button, disabled: modelBusy !== '' || busy !== '', onClick: saveModels },
              modelBusy === 'save' ? T.saving : T.save,
            ),
          ),
        ),
        available === null
          ? null
          : available.length === 0
            ? h('span', { style: css.hint }, T.modelListEmpty)
            : available.map((model) =>
                h(
                  'div',
                  { key: model.id, style: css.modelRow },
                  h('span', { style: { ...css.mono, flex: '1 1 220px' } }, model.id),
                  h('span', { style: css.hint }, model.launchStage || ''),
                  h(
                    'button',
                    { style: css.mini, disabled: modelBusy !== '', onClick: () => toggleModel(model.id) },
                    draft.models.includes(model.id) ? T.removeModel : T.addModel,
                  ),
                  h(
                    'button',
                    { style: css.mini, disabled: modelBusy !== '' || busy !== '', onClick: () => testModel(model.id) },
                    modelBusy === model.id ? T.testingModel : T.testModel,
                  ),
                ),
              ),
      );

      const status = state
        ? h(
            'div',
            { style: css.card },
            h('div', { style: css.label }, T.status),
            h(
              'div',
              { style: css.kv },
              h('span', { style: css.k }, T.credentialKind),
              h(
                'span',
                { style: css.v },
                credential?.ok
                  ? `${credential.kind}${credential.account ? ` · ${credential.account}` : ''}`
                  : `${T.noCredential} — ${credential?.message || ''}`,
              ),
              h('span', { style: css.k }, T.effectiveProject),
              h('span', { style: css.v }, `${state.effective.projectId || '—'} · ${state.effective.location}`),
              h('span', { style: css.k }, T.contextWindow),
              h('span', { style: css.v }, `${Number(state.effective.contextWindow || 1048576).toLocaleString()} tokens`),
              h('span', { style: css.k }, T.credential),
              h(
                'span',
                { ...{ style: { ...css.v, ...css.mono } } },
                state.effective.credentialPath || (state.effective.credentialExists ? 'default ADC (found)' : 'default ADC (not found)'),
              ),
            ),
            h(
              'div',
              { style: css.field },
              h('span', { style: css.label }, T.models),
              h(
                'div',
                { style: css.chips },
                (state.config.models || []).map((model) =>
                  h(
                    'span',
                    { key: model.id, style: { ...css.pill, ...css.mono } },
                    model.id,
                  ),
                ),
              ),
            ),
          )
        : null;

      return h(
        'div',
        { style: css.page },
        header,
        h('p', { style: css.subtitle }, T.subtitle),
        fields,
        modelCard,
        message
          ? h(
              'div',
              {
                style: {
                  ...css.message,
                  ...(message.tone === 'error'
                    ? { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' }
                    : { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' }),
                },
              },
              message.text,
            )
          : null,
        status,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'vertex',
              order: 60,
              label: () => T.title,
            },
            VertexSettings,
          ),
        );
      },
    };
  },
});
