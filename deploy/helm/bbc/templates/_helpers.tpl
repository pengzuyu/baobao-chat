{{/* BaobaoChat Helm 公共模板（16 篇 §3.4 K8s 形态） */}}

{{- define "bbc.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbc.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "bbc.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbc.labels" -}}
helm.sh/chart: {{ include "bbc.chart" . }}
{{ include "bbc.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "bbc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bbc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "bbc.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "bbc.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
bbc.image：统一镜像坐标（同一组镜像=compose 共用，§3.4）
用法：{{ include "bbc.image" (dict "root" $ "repo" "bbc-app") }}
*/}}
{{- define "bbc.image" -}}
{{- $root := index . "root" -}}
{{- $repo := index . "repo" -}}
{{- $tag := $root.Values.global.imageTag | default $root.Chart.AppVersion -}}
{{- printf "%s/%s:%s" $root.Values.global.imageRegistry $repo $tag -}}
{{- end -}}

{{/*
bbc.app.enabledModules：由 values.modules.* 推导 bbc-server --enable 参数
（§3.4 等价映射：compose profiles / BBC_APP_MODULES ↔ Helm values.modules.*；
media/mail 为 infra 开关不进入 --enable，由独立 Deployment 承载）
*/}}
{{- define "bbc.app.enabledModules" -}}
{{- $mods := list -}}
{{- range $k, $v := .Values.modules -}}
{{- if and $v (ne $k "media") (ne $k "mail") -}}
{{- $mods = append $mods $k -}}
{{- end -}}
{{- end -}}
{{- join "," $mods -}}
{{- end -}}

{{/*
bbc.secretNames：Secret 名称解析（支持 existingSecret 引用/external-secrets 接管）
*/}}
{{- define "bbc.secretName.db" -}}
{{- default "bbc-db" .Values.secrets.existingSecretDb -}}
{{- end -}}

{{- define "bbc.secretName.s3" -}}
{{- default "bbc-s3" .Values.secrets.existingSecretS3 -}}
{{- end -}}

{{- define "bbc.secretName.app" -}}
{{- printf "%s-secrets" (include "bbc.fullname" .) -}}
{{- end -}}
