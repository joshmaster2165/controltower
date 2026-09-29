# Control Tower Helm chart

A self-hosted AI gateway with a live map of agent traffic, gates drawn on the map, and human approvals.

```bash
helm install controltower oci://ghcr.io/joshmaster2165/charts/controltower --version 0.1.8
kubectl logs deploy/controltower | grep -A1 "Setup code"   # the setup page asks for it
```

- **One pod on SQLite** (the default), with data on a persistent volume.
- **Several pods on Postgres and Redis:** set `replicaCount`, `database.url`, `redis.url` and `secrets.masterKey`, or put them in a Secret of your own with `secrets.existingSecret`.
- **Hardened by default:** uid 1000, read-only root filesystem, no capabilities. Only `/data` and `/tmp` are writable.
- **Refuses** settings that would lose data, such as several pods on SQLite, or Postgres without a shared master key.

Every value is described in [values.yaml](values.yaml). There's a full guide in the [Kubernetes docs](https://github.com/joshmaster2165/controltower/blob/main/docs/kubernetes.md). The chart and the image are signed with Sigstore. See [Verifying the image](https://github.com/joshmaster2165/controltower/blob/main/docs/install.md#verifying-the-image).
