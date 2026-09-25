import { parse } from 'yaml';

/**
 * Plan a Control Tower `config.yaml`: model_list → providers + deployments,
 * load-balanced model groups and fallbacks → aliases, mcp_servers → MCP
 * servers. Planning is pure and side-effect free, so the console can show
 * exactly what will be created — and which secrets are still missing — before
 * anything is written.
 *
 * Secrets: literal values are used as given. `os.environ/NAME` references
 * (and the usual provider variables such as OPENAI_API_KEY) are resolved from
 * this server's environment when present; otherwise the plan lists them as
 * missing and the admin fills them in. Control Tower's own `CT_*` variables
 * are never resolved, so a config cannot read the master key.
 *
 * Keys: `params`, `settings` and `credential` are the documented names; the
 * long-form `litellm_params`, `litellm_settings` and `litellm_credential_name`
 * used by other gateways' files are accepted too.
 */

export type ImportCatalogId =
  | 'openai'
  | 'azure-openai'
  | 'anthropic'
  | 'gemini'
  | 'vertex'
  | 'bedrock'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'openrouter'
  | 'perplexity'
  | 'ollama'
  | 'vllm'
  | 'lmstudio'
  | 'custom';

export interface CredSource {
  field: string;
  label: string;
  secret: boolean;
  /** Where the value comes from. */
  from: 'literal' | 'env' | 'default_env' | 'missing';
  env?: string | undefined;
  required: boolean;
}

export interface PlannedProvider {
  ref: string;
  catalogId: ImportCatalogId;
  name: string;
  slug: string;
  baseUrl: string | undefined;
  extra: Record<string, unknown>;
  creds: CredSource[];
  /** Resolved values, never sent to the browser. */
  values: Record<string, string>;
  /** Stable identity (endpoint + credential source): config imports keep ids across restarts. */
  sig: string;
  /** From a wildcard entry (`openai/*`, `"*"`): no deployments; models are added on first use. */
  wildcard?: boolean;
}

export interface PlannedDeployment {
  ref: string;
  providerRef: string;
  upstreamModel: string;
  /** Set when the model group has exactly one deployment and no fallbacks. */
  publicName: string | null;
  group: string;
  weight: number;
  order: number;
  pricing: { input: number; output: number; mode: 'chat' | 'embedding' } | null;
  /** Stable identity within the file. */
  sig: string;
}

export interface PlannedAlias {
  name: string;
  strategy: 'priority' | 'weighted' | 'least-latency' | 'least-cost';
  targets: Array<{ deploymentRef: string; priority: number; weight: number; viaFallback?: string | undefined }>;
}

export interface PlannedMcp {
  name: string;
  slug: string;
  url: string;
  /** From auth_type/auth_value and static_headers; never sent to the browser. */
  auth?: { type: 'bearer'; token: string } | { type: 'headers'; headers: Record<string, string> } | undefined;
}

/** Settings honoured when the file is loaded at boot with --config. */
export interface PlannedSettings {
  /** general_settings.master_key: the admin bearer token. */
  masterKey?: string;
  /** general_settings.alerting: ["slack"] with SLACK_WEBHOOK_URL. */
  slack?: { webhook: string; alertTypes: string[] };
}

export interface ImportPlan {
  settings: PlannedSettings;
  providers: PlannedProvider[];
  deployments: PlannedDeployment[];
  aliases: PlannedAlias[];
  mcpServers: PlannedMcp[];
  warnings: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface ExistingNames {
  providerSlugs: Set<string>;
  modelNames: Set<string>;
  mcpSlugs: Set<string>;
}

interface PrefixInfo {
  catalogId: ImportCatalogId;
  label: string;
  baseUrl?: string;
  defaultKeyEnv?: string;
}

/** Provider prefix in `params.model` → Control Tower catalogue entry. */
const PREFIXES: Record<string, PrefixInfo> = {
  openai: { catalogId: 'openai', label: 'OpenAI', defaultKeyEnv: 'OPENAI_API_KEY' },
  text_completion_openai: { catalogId: 'openai', label: 'OpenAI', defaultKeyEnv: 'OPENAI_API_KEY' },
  azure: { catalogId: 'azure-openai', label: 'Azure OpenAI', defaultKeyEnv: 'AZURE_API_KEY' },
  azure_ai: { catalogId: 'custom', label: 'Azure AI Foundry', defaultKeyEnv: 'AZURE_AI_API_KEY' },
  anthropic: { catalogId: 'anthropic', label: 'Anthropic', defaultKeyEnv: 'ANTHROPIC_API_KEY' },
  gemini: { catalogId: 'gemini', label: 'Google Gemini', defaultKeyEnv: 'GEMINI_API_KEY' },
  vertex_ai: { catalogId: 'vertex', label: 'Google Vertex AI' },
  vertex_ai_beta: { catalogId: 'vertex', label: 'Google Vertex AI' },
  bedrock: { catalogId: 'bedrock', label: 'AWS Bedrock' },
  groq: { catalogId: 'groq', label: 'Groq', defaultKeyEnv: 'GROQ_API_KEY' },
  mistral: { catalogId: 'mistral', label: 'Mistral', defaultKeyEnv: 'MISTRAL_API_KEY' },
  together_ai: { catalogId: 'together', label: 'Together AI', defaultKeyEnv: 'TOGETHERAI_API_KEY' },
  fireworks_ai: { catalogId: 'fireworks', label: 'Fireworks', defaultKeyEnv: 'FIREWORKS_AI_API_KEY' },
  deepseek: { catalogId: 'deepseek', label: 'DeepSeek', defaultKeyEnv: 'DEEPSEEK_API_KEY' },
  xai: { catalogId: 'xai', label: 'xAI', defaultKeyEnv: 'XAI_API_KEY' },
  openrouter: { catalogId: 'openrouter', label: 'OpenRouter', defaultKeyEnv: 'OPENROUTER_API_KEY' },
  perplexity: { catalogId: 'perplexity', label: 'Perplexity', defaultKeyEnv: 'PERPLEXITYAI_API_KEY' },
  cerebras: { catalogId: 'custom', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', defaultKeyEnv: 'CEREBRAS_API_KEY' },
  deepinfra: { catalogId: 'custom', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', defaultKeyEnv: 'DEEPINFRA_API_KEY' },
  nvidia_nim: { catalogId: 'custom', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', defaultKeyEnv: 'NVIDIA_NIM_API_KEY' },
  sambanova: { catalogId: 'custom', label: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', defaultKeyEnv: 'SAMBANOVA_API_KEY' },
  ollama: { catalogId: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  ollama_chat: { catalogId: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  hosted_vllm: { catalogId: 'vllm', label: 'vLLM', defaultKeyEnv: 'HOSTED_VLLM_API_KEY' },
  lm_studio: { catalogId: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  litellm_proxy: { catalogId: 'custom', label: 'Upstream gateway', defaultKeyEnv: 'LITELLM_PROXY_API_KEY' },
};

/** Hosts that mean a named catalogue entry even when the config says `openai/` + api_base. */
const KNOWN_HOSTS: Array<[string, ImportCatalogId]> = [
  ['api.groq.com', 'groq'],
  ['api.mistral.ai', 'mistral'],
  ['api.together.xyz', 'together'],
  ['api.together.ai', 'together'],
  ['api.fireworks.ai', 'fireworks'],
  ['api.deepseek.com', 'deepseek'],
  ['api.x.ai', 'xai'],
  ['openrouter.ai', 'openrouter'],
  ['api.perplexity.ai', 'perplexity'],
];

const CATALOG_LABEL: Partial<Record<ImportCatalogId, string>> = { groq: 'Groq', mistral: 'Mistral', together: 'Together AI', fireworks: 'Fireworks', deepseek: 'DeepSeek', xai: 'xAI', openrouter: 'OpenRouter', perplexity: 'Perplexity' };

const STRATEGY: Record<string, PlannedAlias['strategy']> = {
  'simple-shuffle': 'weighted',
  'least-busy': 'weighted',
  'usage-based-routing': 'weighted',
  'usage-based-routing-v2': 'weighted',
  'latency-based-routing': 'least-latency',
  'cost-based-routing': 'least-cost',
};

const IGNORED_GENERAL = ['database_url', 'alerting_threshold', 'custom_auth', 'enable_jwt_auth', 'litellm_jwtauth', 'ui_access_mode', 'disable_spend_logs'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !isNaN(Number(v)) ? Number(v) : undefined);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'imported';
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = slugify(base);
  for (let i = 2; taken.has(slug); i++) slug = `${slugify(base).slice(0, 21)}-${i}`;
  taken.add(slug);
  return slug;
}

export class ImportError extends Error {}

/** Accept the long-form keys other gateways' files use, mapped onto the documented ones. */
function normalizeKeys(doc: Obj): void {
  if (isObj(doc.litellm_settings) && !isObj(doc.settings)) doc.settings = doc.litellm_settings;
  if (!Array.isArray(doc.model_list)) return;
  for (const m of doc.model_list as unknown[]) {
    if (!isObj(m)) continue;
    if (isObj(m.litellm_params) && !isObj(m.params)) m.params = m.litellm_params;
    const p = m.params;
    if (isObj(p) && typeof p.litellm_credential_name === 'string' && p.credential === undefined) p.credential = p.litellm_credential_name;
  }
}


export function planConfigImport(yamlText: string, env: Record<string, string | undefined>, existing: ExistingNames): ImportPlan {
  let doc: unknown;
  try {
    doc = parse(yamlText, { maxAliasCount: 100 });
  } catch (e) {
    throw new ImportError(`Not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(doc)) throw new ImportError('Expected a config.yaml with a model_list.');
  normalizeKeys(doc);
  const warnings: string[] = [];
  const skipped: ImportPlan['skipped'] = [];
  const settings: PlannedSettings = {};

  // `environment_variables` in the file take part in os.environ resolution.
  const fileEnv: Record<string, string> = {};
  if (isObj(doc.environment_variables)) for (const [k, v] of Object.entries(doc.environment_variables)) if (str(v) !== undefined && !String(v).startsWith('os.environ/')) fileEnv[k] = String(v);
  const lookupEnv = (name: string): string | undefined => {
    if (/^CT_/i.test(name)) return undefined;
    return fileEnv[name] ?? env[name] ?? undefined;
  };

  if (doc.include) warnings.push('`include` files are not followed — paste the combined config (or import each file).');
  if (isObj(doc.general_settings)) {
    const gs = doc.general_settings;
    const ignored = IGNORED_GENERAL.filter((k) => k in gs);
    if (ignored.length) warnings.push(`general_settings ignored (Control Tower has its own): ${ignored.join(', ')}.`);
    if (gs.store_model_in_db === true) warnings.push('store_model_in_db is on: models stored only in another database are not in this file and are not imported.');
    if (gs.key_management_system) warnings.push(`key_management_system (${String(gs.key_management_system)}) is not used: secrets are read from the environment or entered in the console.`);
    const mk = str(gs.master_key);
    const mkValue = mk?.startsWith('os.environ/') ? lookupEnv(mk.slice('os.environ/'.length)) : mk;
    if (mkValue) settings.masterKey = mkValue;
    if (Array.isArray(gs.alerting) && gs.alerting.map(String).includes('slack')) {
      const webhook = lookupEnv('SLACK_WEBHOOK_URL');
      if (webhook) settings.slack = { webhook, alertTypes: Array.isArray(gs.alert_types) ? gs.alert_types.map(String) : [] };
      else warnings.push('alerting: ["slack"] needs SLACK_WEBHOOK_URL in the environment — Slack alerts skipped.');
    }
  }
  for (const k of ['guardrails', 'callback_settings', 'mcp_tools', 'prompts', 'policies', 'vector_store_registry']) if (k in doc) warnings.push(`\`${k}\` is not imported.`);
  if (isObj(doc.settings) && (doc.settings.callbacks || doc.settings.success_callback)) warnings.push('Logging callbacks are not imported — Control Tower records every flight itself; use /metrics or alert webhooks for export.');

  // Named credential sets.
  const credentialSets = new Map<string, Obj>();
  if (Array.isArray(doc.credential_list)) {
    for (const c of doc.credential_list) if (isObj(c) && str(c.credential_name) && isObj(c.credential_values)) credentialSets.set(str(c.credential_name)!, c.credential_values);
  }

  const models = Array.isArray(doc.model_list) ? doc.model_list : [];
  if (!models.length && !isObj(doc.mcp_servers) && !isObj(doc.general_settings)) throw new ImportError('No model_list found in this file.');

  const providers = new Map<string, PlannedProvider>();
  const providerSlugs = new Set(existing.providerSlugs);
  const deployments: PlannedDeployment[] = [];
  const nameCount = new Map<string, number>();

  const credFrom = (raw: unknown, field: string, label: string, secret: boolean, required: boolean, defaultEnv: string | undefined, values: Record<string, string>): CredSource => {
    const s = str(raw);
    if (s !== undefined && s.startsWith('os.environ/')) {
      const name = s.slice('os.environ/'.length);
      const v = lookupEnv(name);
      if (v) values[field] = v;
      return { field, label, secret, required, from: v ? 'env' : 'missing', env: name };
    }
    if (s !== undefined && s.startsWith('oidc/')) {
      warnings.push(`${label}: OIDC federation (${s.split('/').slice(0, 2).join('/')}/…) is not supported — enter a credential instead.`);
      return { field, label, secret, required, from: 'missing' };
    }
    if (s !== undefined && s !== '') {
      values[field] = s;
      return { field, label, secret, required, from: 'literal' };
    }
    if (defaultEnv) {
      const v = lookupEnv(defaultEnv);
      if (v) values[field] = v;
      // Read quietly, never named back to the user: a variable from another gateway's conventions.
      const shown = /^LITELLM_/.test(defaultEnv) ? {} : { env: defaultEnv };
      return { field, label, secret, required, from: v ? 'default_env' : 'missing', ...shown };
    }
    return { field, label, secret, required, from: 'missing' };
  };

  const keepProviders = new Set<string>();
  const handle = (m: unknown, i: number): void => {
    if (!isObj(m) || !isObj(m.params)) {
      skipped.push({ name: `model_list[${i}]`, reason: 'missing params' });
      return;
    }
    const group = str(m.model_name) ?? '';
    const lp: Obj = { ...(credentialSets.get(str(m.params.credential) ?? '') ?? {}), ...m.params };
    const info = isObj(m.model_info) ? m.model_info : {};
    const model = str(lp.model) ?? '';
    if (!group || !model) {
      skipped.push({ name: group || `model_list[${i}]`, reason: 'model_name and params.model are required' });
      return;
    }
    const wildcard = group.includes('*') || model.includes('*');
    if (wildcard && model === '*') {
      // `model: "*"` passes any provider/model through with credentials from the environment:
      // connect every provider whose standard API key variable is set.
      let found = 0;
      for (const [prefix, info] of Object.entries(PREFIXES)) {
        if (!info.defaultKeyEnv || info.catalogId === 'custom' || info.catalogId === 'azure-openai' || !lookupEnv(info.defaultKeyEnv)) continue;
        found++;
        handle({ model_name: `${prefix}/*`, params: { model: `${prefix}/*` } }, i);
      }
      if (!found) skipped.push({ name: group, reason: 'model "*" connects the providers whose API keys are in the environment — none were found' });
      return;
    }
    if (wildcard && !/^[a-z_]+\/\*$/.test(model)) {
      skipped.push({ name: group, reason: 'only provider/* wildcards are supported — add other patterns as explicit models' });
      return;
    }
    const mode = str(info.mode) ?? 'chat';
    if (mode !== 'chat' && mode !== 'completion' && mode !== 'embedding') {
      skipped.push({ name: group, reason: `mode "${mode}" is not supported yet` });
      return;
    }
    let prefix = str(lp.custom_llm_provider) ?? (model.includes('/') ? model.slice(0, model.indexOf('/')) : '');
    let upstream = model.includes('/') && !lp.custom_llm_provider ? model.slice(model.indexOf('/') + 1) : model;
    if (!prefix) {
      prefix = 'openai';
      warnings.push(`${group}: no provider prefix on "${model}" — assumed OpenAI.`);
    }
    const p = PREFIXES[prefix];
    if (!p) {
      skipped.push({ name: group, reason: `provider "${prefix}" is not supported yet` });
      return;
    }
    if (prefix === 'bedrock') upstream = upstream.replace(/^(converse|invoke|converse_like)\//, '');
    const apiBase = str(lp.api_base) ?? str(lp.base_url);
    let catalogId = p.catalogId;
    let label = p.label;
    let baseUrl = apiBase ?? p.baseUrl;
    if (catalogId === 'openai' && apiBase && !/api\.openai\.com/.test(apiBase)) {
      const known = KNOWN_HOSTS.find(([h]) => apiBase.includes(h));
      catalogId = known ? known[1] : 'custom';
      label = known ? CATALOG_LABEL[known[1]]! : `OpenAI-compatible (${hostOf(apiBase)})`;
      if (known) baseUrl = undefined;
    }
    if ((catalogId === 'azure-openai' || catalogId === 'vllm' || (catalogId === 'custom' && !p.baseUrl)) && !apiBase) {
      skipped.push({ name: group, reason: `${label} needs api_base` });
      return;
    }
    if ((catalogId === 'ollama' || catalogId === 'lmstudio') && apiBase && !/\/v1\/?$/.test(apiBase)) baseUrl = `${apiBase.replace(/\/+$/, '')}/v1`;

    const values: Record<string, string> = {};
    const creds: CredSource[] = [];
    const extra: Record<string, unknown> = {};
    if (catalogId === 'bedrock') {
      creds.push(credFrom(lp.aws_access_key_id, 'access_key_id', 'AWS access key ID', false, true, 'AWS_ACCESS_KEY_ID', values));
      creds.push(credFrom(lp.aws_secret_access_key, 'secret_access_key', 'AWS secret access key', true, true, 'AWS_SECRET_ACCESS_KEY', values));
      if (lp.aws_session_token) creds.push(credFrom(lp.aws_session_token, 'session_token', 'AWS session token', true, false, undefined, values));
      creds.push(credFrom(lp.aws_region_name, 'region', 'AWS region', false, true, 'AWS_REGION_NAME', values));
      if (lp.aws_role_name || lp.aws_profile_name || lp.aws_web_identity_token) warnings.push(`${group}: AWS role / profile / web-identity auth is not imported — use access keys.`);
      if (str(lp.aws_bedrock_runtime_endpoint)) extra.endpoint = str(lp.aws_bedrock_runtime_endpoint);
    } else if (catalogId === 'vertex') {
      const vc = lp.vertex_credentials;
      if (isObj(vc)) {
        values.service_account_json = JSON.stringify(vc);
        creds.push({ field: 'service_account_json', label: 'Service account JSON', secret: true, required: true, from: 'literal' });
      } else if (typeof vc === 'string' && !vc.startsWith('os.environ/') && !vc.trim().startsWith('{')) {
        creds.push({ field: 'service_account_json', label: `Service account JSON (the config points at the file ${vc})`, secret: true, required: true, from: 'missing' });
      } else {
        creds.push(credFrom(vc, 'service_account_json', 'Service account JSON', true, true, 'GOOGLE_APPLICATION_CREDENTIALS_JSON', values));
      }
      const project = str(lp.vertex_project) ?? lookupEnv('VERTEXAI_PROJECT');
      const location = str(lp.vertex_location) ?? lookupEnv('VERTEXAI_LOCATION') ?? 'us-central1';
      if (!project) {
        skipped.push({ name: group, reason: 'vertex_project is required' });
        return;
      }
      extra.project = project.startsWith('os.environ/') ? (lookupEnv(project.slice(11)) ?? project) : project;
      extra.location = location;
    } else if (catalogId !== 'ollama' && catalogId !== 'lmstudio') {
      const required = catalogId !== 'vllm' && catalogId !== 'custom';
      const key = credFrom(lp.api_key, 'api_key', 'API key', true, required, p.defaultKeyEnv, values);
      if (key.from !== 'missing' || required || lp.api_key) creds.push(key);
      if (catalogId === 'azure-openai') extra.api_version = str(lp.api_version) ?? lookupEnv('AZURE_API_VERSION') ?? '2024-10-21';
    }
    // Configs often say `api_key: none` for keyless local endpoints.
    if ((catalogId === 'custom' || catalogId === 'vllm') && (!values.api_key || values.api_key.toLowerCase() === 'none')) {
      delete values.api_key;
      for (let i = creds.length - 1; i >= 0; i--) if (creds[i]!.field === 'api_key') creds.splice(i, 1);
      extra.auth_style = 'none';
    }

    // One Control Tower provider per distinct endpoint + credential.
    const idKey = JSON.stringify([catalogId, baseUrl ?? '', creds.map((c) => [c.field, c.env ?? '', c.from === 'literal' ? values[c.field] : '']), extra]);
    let prov = providers.get(idKey);
    if (!prov) {
      const credName = str(m.params.credential);
      const sameKind = [...providers.values()].filter((x) => x.catalogId === catalogId).length;
      const name = credName ?? (catalogId === 'azure-openai' && baseUrl ? `Azure ${hostOf(baseUrl).split('.')[0]}` : sameKind ? `${label} ${sameKind + 1}` : label);
      prov = { ref: `p${providers.size + 1}`, catalogId, name, slug: uniqueSlug(name, providerSlugs), baseUrl, extra, creds, values, sig: idKey };
      providers.set(idKey, prov);
    }
    if (wildcard) {
      prov.wildcard = true;
      keepProviders.add(prov.ref);
      warnings.push(`${group}: ${label} is connected; its models are added the first time an agent asks for one.`);
      return;
    }

    const inCost = num(lp.input_cost_per_token) ?? num(info.input_cost_per_token);
    const outCost = num(lp.output_cost_per_token) ?? num(info.output_cost_per_token);
    nameCount.set(group, (nameCount.get(group) ?? 0) + 1);
    deployments.push({
      sig: `${group}|${prov.sig}|${upstream}|${nameCount.get(group)}`,
      ref: `d${deployments.length + 1}`,
      providerRef: prov.ref,
      upstreamModel: upstream,
      publicName: null,
      group,
      weight: Math.max(1, Math.round(num(lp.weight) ?? num(lp.rpm) ?? num(lp.tpm) ?? 100)),
      order: num(lp.order) ?? 0,
      pricing: inCost !== undefined && outCost !== undefined ? { input: inCost * 1e6, output: outCost * 1e6, mode: mode === 'embedding' ? 'embedding' : 'chat' } : null,
    });
  };
  models.forEach((m, i) => handle(m, i));

  // ---- routing: strategy, fallbacks, group aliases ----
  const rs = isObj(doc.router_settings) ? doc.router_settings : {};
  const ls = isObj(doc.settings) ? doc.settings : {};
  const strategyName = str(rs.routing_strategy) ?? 'simple-shuffle';
  const strategy = STRATEGY[strategyName] ?? 'weighted';
  if (!STRATEGY[strategyName]) warnings.push(`routing_strategy "${strategyName}" has no equivalent — using weighted.`);
  const pickFallbacks = (key: string): unknown => (Array.isArray(rs[key]) && (rs[key] as unknown[]).length ? rs[key] : ls[key]);
  const fallbacks = new Map<string, string[]>();
  const fb = pickFallbacks('fallbacks');
  if (Array.isArray(fb)) {
    for (const entry of fb) {
      if (!isObj(entry) || Object.keys(entry).length !== 1) {
        warnings.push('A fallbacks entry is not in the {model: [fallbacks]} form and was skipped.');
        continue;
      }
      const [from, to] = Object.entries(entry)[0]!;
      if (from === '*') {
        warnings.push('Generic "*" fallbacks are not imported — add fallbacks per model.');
        continue;
      }
      if (Array.isArray(to)) fallbacks.set(from, to.map(String));
    }
  }
  if (Array.isArray(pickFallbacks('default_fallbacks')) && (pickFallbacks('default_fallbacks') as unknown[]).length) warnings.push('default_fallbacks are not imported — add fallbacks per model.');
  for (const k of ['context_window_fallbacks', 'content_policy_fallbacks']) {
    const v = pickFallbacks(k);
    if (Array.isArray(v) && v.length) warnings.push(`${k} are not imported yet (only regular fallbacks are).`);
  }

  const groups = [...nameCount.keys()];
  const byGroup = (g: string) => deployments.filter((d) => d.group === g);
  const aliases: PlannedAlias[] = [];
  const modelNames = new Set(existing.modelNames);
  for (const g of groups) {
    const ds = byGroup(g);
    if (modelNames.has(g)) {
      skipped.push({ name: g, reason: 'a model or alias with this name already exists in Control Tower' });
      for (const d of ds) deployments.splice(deployments.indexOf(d), 1);
      continue;
    }
    modelNames.add(g);
    const fbs = (fallbacks.get(g) ?? []).filter((f) => {
      if (nameCount.has(f)) return true;
      warnings.push(`${g}: fallback "${f}" is not a model in this file — skipped.`);
      return false;
    });
    if (ds.length === 1 && !fbs.length) {
      ds[0]!.publicName = g;
      continue;
    }
    // Lower `order` is tried first; fallbacks come after every tier of the group itself.
    const orders = [...new Set(ds.map((d) => d.order))].sort((a, b) => a - b);
    const targets: PlannedAlias['targets'] = ds.map((d) => ({ deploymentRef: d.ref, priority: orders.indexOf(d.order), weight: d.weight }));
    let next = orders.length;
    for (const f of fbs) {
      for (const d of byGroup(f)) targets.push({ deploymentRef: d.ref, priority: next, weight: d.weight, viaFallback: f });
      next++;
    }
    aliases.push({ name: g, strategy: orders.length > 1 && ds.length === orders.length ? 'priority' : strategy, targets });
  }
  // model_group_alias: extra names for an existing group.
  if (isObj(rs.model_group_alias)) {
    for (const [alias, target] of Object.entries(rs.model_group_alias)) {
      const g = isObj(target) ? str(target.model) : str(target);
      if (!g || !nameCount.has(g) || modelNames.has(alias)) {
        warnings.push(`model_group_alias "${alias}" skipped.`);
        continue;
      }
      modelNames.add(alias);
      aliases.push({ name: alias, strategy, targets: byGroup(g).map((d) => ({ deploymentRef: d.ref, priority: 0, weight: d.weight })) });
    }
  }

  // ---- MCP servers ----
  const mcpServers: PlannedMcp[] = [];
  const mcpSlugs = new Set(existing.mcpSlugs);
  if (isObj(doc.mcp_servers)) {
    for (const [name, v] of Object.entries(doc.mcp_servers)) {
      if (!isObj(v)) continue;
      const url = str(v.url);
      const transport = str(v.transport) ?? 'http';
      if (!url || !/^https?:\/\//.test(url)) {
        skipped.push({ name: `MCP ${name}`, reason: transport === 'stdio' || v.command ? 'stdio servers are not supported (run it behind an HTTP bridge)' : 'no http(s) url' });
        continue;
      }
      if (transport === 'sse') warnings.push(`MCP ${name}: SSE transport — Control Tower connects with streamable HTTP; check the server supports it.`);
      // auth_type + auth_value (bearer_token, api_key, basic) and static_headers, with os.environ/ references.
      const resolve = (raw: unknown): string | undefined => {
        const s = str(raw);
        return s?.startsWith('os.environ/') ? lookupEnv(s.slice('os.environ/'.length)) : s;
      };
      let auth: PlannedMcp['auth'];
      const authType = str(v.auth_type);
      const authValue = resolve(v.auth_value ?? v.authentication_token);
      const headers: Record<string, string> = {};
      if (isObj(v.static_headers)) for (const [k, hv] of Object.entries(v.static_headers)) {
        const r = resolve(hv);
        if (r) headers[k] = r;
      }
      if (authType && !authValue) warnings.push(`MCP ${name}: auth_value for ${authType} is not set — add credentials on the MCP page.`);
      else if (authType === 'bearer_token' || (!authType && authValue)) auth = { type: 'bearer', token: authValue! };
      else if (authType === 'api_key') headers['x-api-key'] = authValue!;
      else if (authType === 'basic') headers.authorization = `Basic ${authValue!.includes(':') ? Buffer.from(authValue!).toString('base64') : authValue!}`;
      else if (authType) warnings.push(`MCP ${name}: auth_type ${authType} is not supported — add credentials on the MCP page.`);
      if (!auth && Object.keys(headers).length) auth = { type: 'headers', headers };
      else if (auth && Object.keys(headers).length) warnings.push(`MCP ${name}: static_headers alongside a bearer token — only the token is used.`);
      mcpServers.push({ name, slug: uniqueSlug(name, mcpSlugs), url, auth });
    }
  }

  const usedProviders = new Set([...deployments.map((d) => d.providerRef), ...keepProviders]);
  return { settings, providers: [...providers.values()].filter((p) => usedProviders.has(p.ref)), deployments, aliases, mcpServers, warnings, skipped };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The plan as the console sees it: no secret values, only where each one comes from. */
export function publicPlan(p: ImportPlan): Record<string, unknown> {
  return {
    providers: p.providers.map((x) => ({ ref: x.ref, catalog_id: x.catalogId, name: x.name, slug: x.slug, base_url: x.baseUrl ?? null, creds: x.creds })),
    deployments: p.deployments.map((d) => ({ ref: d.ref, provider_ref: d.providerRef, upstream_model: d.upstreamModel, public_name: d.publicName, group: d.group, weight: d.weight, priced: !!d.pricing })),
    aliases: p.aliases.map((a) => ({ name: a.name, strategy: a.strategy, targets: a.targets.map((t) => ({ deployment_ref: t.deploymentRef, priority: t.priority, weight: t.weight, via_fallback: t.viaFallback ?? null })) })),
    mcp_servers: p.mcpServers.map((m) => ({ name: m.name, slug: m.slug, url: m.url, auth: m.auth?.type ?? 'none' })),
    warnings: p.warnings,
    skipped: p.skipped,
    missing: p.providers.flatMap((x) => x.creds.filter((c) => c.from === 'missing' && c.required).map((c) => ({ provider_ref: x.ref, provider: x.name, field: c.field, label: c.label, env: c.env ?? null }))),
  };
}
