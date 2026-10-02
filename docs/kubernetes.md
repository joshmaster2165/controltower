# Kubernetes

The Helm chart runs Control Tower the way the image is meant to run: as an unprivileged user, on a read-only root filesystem, with health probes and a clean shutdown. It is published with each release at `oci://ghcr.io/joshmaster2165/charts/controltower`, and signed like the image (see [Verifying the image](install.md#verifying-the-image)).

## One pod on SQLite

The default: one pod, with its data on a persistent volume.

```bash
helm install controltower oci://ghcr.io/joshmaster2165/charts/controltower --version 0.2.6
```

Then open the console. With no ingress, port-forward:

```bash
kubectl port-forward svc/controltower 4000:4000
```

The setup page asks for the setup code, which the pod prints when it starts:

```bash
kubectl logs deploy/controltower | grep -A1 "Setup code"
```

The chart's notes, printed after install, repeat these steps with your release's names.

**Back up the master key.** On SQLite it is generated on the volume, and stored provider credentials can't be read without it:

```bash
kubectl exec deploy/controltower -- cat /data/master.key
```

Or supply your own with `secrets.masterKey` (`openssl rand -base64 32`). Uninstalling keeps the volume. Delete the PersistentVolumeClaim yourself to remove the data.

## Several pods on Postgres and Redis

To run more than one pod, give every pod the same Postgres database, Redis and master key (see [Running several instances](scaling.md)):

```yaml
# values.yaml
replicaCount: 3
secrets:
  existingSecret: controltower   # holds CT_MASTER_KEY and CT_ADMIN_KEY
database:
  inExistingSecret: true         # CT_DATABASE_URL is in the Secret too
redis:
  url: redis://redis-master:6379
```

```bash
kubectl create secret generic controltower \
  --from-literal=CT_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=CT_ADMIN_KEY="sk-$(openssl rand -hex 32)" \
  --from-literal=CT_DATABASE_URL='postgres://controltower:…@postgres:5432/controltower'
helm install controltower oci://ghcr.io/joshmaster2165/charts/controltower --version 0.2.6 -f values.yaml
```

With Postgres, pods roll one at a time and a PodDisruptionBudget keeps one serving during node drains. The chart refuses settings that would lose data or never work:

| Setting | Refused because |
|---|---|
| `replicaCount` above 1 on SQLite | SQLite has one writer |
| `replicaCount` above 1 without Redis | Pods share limits, budgets, approvals and live traffic over Redis |
| Postgres without `secrets.masterKey` (or `existingSecret`) | Each pod would generate its own key, and lose it on restart |
| `serviceMonitor.enabled` without a metrics token | `/metrics` is never anonymous |

## Values

| Value | Default | |
|---|---|---|
| `image.tag` | the chart's version | Pin a digest in production: `0.2.6@sha256:…` |
| `publicUrl` | the ingress host | Sets `CT_PUBLIC_URL`: links in alerts and approval messages, and `Secure` cookies over https |
| `secrets.masterKey`, `adminKey`, `setupToken`, `metricsToken` | empty | `CT_MASTER_KEY`, `CT_ADMIN_KEY`, `CT_SETUP_TOKEN`, `CT_METRICS_TOKEN`. The chart keeps them in a Secret |
| `secrets.existingSecret` | empty | Your own Secret with any of those keys, plus `CT_DATABASE_URL` and `CT_REDIS_URL` |
| `database.url`, `redis.url` | empty | Postgres and Redis. Set `inExistingSecret: true` when they are in your Secret instead |
| `env`, `envFrom` | empty | Provider keys and any [setting](configuration.md), as environment variables |
| `config` | empty | A [config file](config-file.md) (models, aliases, MCP servers) loaded at start. Refer to secrets as `os.environ/NAME` |
| `policy` | empty | [Gates and zones](policy-as-code.md) as YAML, loaded at start |
| `persistence.size`, `storageClass`, `existingClaim` | `5Gi` | The SQLite volume. Not used with Postgres |
| `ingress.*` | off | The console's live map uses a WebSocket on `/admin/ws`; most ingress controllers pass it through as is |
| `resources` | 100m CPU, 256Mi–1Gi | |
| `serviceMonitor.enabled` | off | Prometheus Operator scraping of `/metrics`, with `secrets.metricsToken` |
| `podSecurityContext`, `securityContext` | uid 1000, read-only root, no capabilities | Only `/data` and `/tmp` are writable |

Every value is described in the chart's [values.yaml](https://github.com/joshmaster2165/controltower/blob/main/deploy/helm/controltower/values.yaml).

Provider keys, for example, from a Secret of your own:

```yaml
env:
  - name: OPENAI_API_KEY
    valueFrom: { secretKeyRef: { name: llm-keys, key: openai } }
config: |
  model_list:
    - model_name: gpt-4.1-mini
      params: { model: openai/gpt-4.1-mini, api_key: os.environ/OPENAI_API_KEY }
```

## Checking it

```bash
helm test controltower
```

This starts a pod that asks the service whether it is ready. For a report to send with a support request (no keys, prompts or names in it), see [Support](https://github.com/joshmaster2165/controltower/blob/main/SUPPORT.md#what-to-include):

```bash
kubectl exec deploy/controltower -- node dist/server.mjs --support-bundle > support-bundle.json
```

## Upgrading

```bash
helm upgrade controltower oci://ghcr.io/joshmaster2165/charts/controltower --version <new version> --reuse-values
```

Migrations run when the new pod starts. On SQLite the old pod stops first (the volume can only be attached to one pod at a time), so expect a few seconds of downtime. On Postgres, pods are replaced one at a time with no downtime.
