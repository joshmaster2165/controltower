{{- define "controltower.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "controltower.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "controltower.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "controltower.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "controltower.selectorLabels" -}}
app.kubernetes.io/name: {{ include "controltower.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "controltower.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "controltower.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The Secret the pod reads CT_* secrets from: the user's own, or the one this chart makes. */}}
{{- define "controltower.secretName" -}}
{{- default (include "controltower.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "controltower.postgres" -}}
{{- if or .Values.database.url .Values.database.inExistingSecret }}true{{ end }}
{{- end }}

{{- define "controltower.redis" -}}
{{- if or .Values.redis.url .Values.redis.inExistingSecret }}true{{ end }}
{{- end }}

{{- define "controltower.publicUrl" -}}
{{- if .Values.publicUrl }}
{{- .Values.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (first .Values.ingress.hosts).host }}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) $host }}
{{- end }}
{{- end }}

{{/* Settings that can't work together stop the install with a reason, instead of a pod that loses data. */}}
{{- define "controltower.validate" -}}
{{- $pg := include "controltower.postgres" . }}
{{- $keyGiven := or .Values.secrets.masterKey .Values.secrets.existingSecret }}
{{- if and (gt (int .Values.replicaCount) 1) (not $pg) }}
{{- fail "replicaCount > 1 needs Postgres and Redis: SQLite has one writer. Set database.url and redis.url (or keep replicaCount: 1)." }}
{{- end }}
{{- if and (gt (int .Values.replicaCount) 1) (not (include "controltower.redis" .)) }}
{{- fail "replicaCount > 1 needs redis.url: instances share limits, budgets, approvals and live traffic over Redis." }}
{{- end }}
{{- if and $pg (not $keyGiven) }}
{{- fail "With Postgres, set secrets.masterKey (or existingSecret with CT_MASTER_KEY): every pod must use the same one, and a generated key would be lost with the pod. Generate one with: openssl rand -base64 32" }}
{{- end }}
{{- end }}
