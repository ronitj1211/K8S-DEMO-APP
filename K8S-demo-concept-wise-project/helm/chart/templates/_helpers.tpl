{{/*
  Common helpers. Anything starting with `_` is a partial — not rendered as a
  manifest, just used by `include` in other templates.
*/}}

{{/* Release-scoped name for a component. */}}
{{- define "k8s-demo.fullname" -}}
{{- printf "%s-%s" .Release.Name .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard labels every resource should have. */}}
{{- define "k8s-demo.labels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
