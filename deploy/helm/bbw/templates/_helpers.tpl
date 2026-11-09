{{/* BaobaoWork Helm 公共模板（16 篇 §3.4 K8s 形态） */}}

{{- define "bbw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbw.fullname" -}}
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

{{- define "bbw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbw.labels" -}}
helm.sh/chart: {{ include "bbw.chart" . }}
{{ include "bbw.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "bbw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bbw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "bbw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "bbw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
bbw.image：统一镜像坐标（同一组镜像=compose 共用，§3.4）
用法：{{ include "bbw.image" (dict "root" $ "repo" "bbw-app") }}
*/}}
{{- define "bbw.image" -}}
{{- $root := index . "root" -}}
{{- $repo := index . "repo" -}}
{{- $tag := $root.Values.global.imageTag | default $root.Chart.AppVersion -}}
{{- printf "%s/%s:%s" $root.Values.global.imageRegistry $repo $tag -}}
{{- end -}}

{{/*
bbw.app.enabledModules：由 values.modules.* 推导 bbw-server --enable 参数
（§3.4 等价映射：compose profiles / BBW_APP_MODULES ↔ Helm values.modules.*；
media/mail 为 infra 开关不进入 --enable，由独立 Deployment 承载）
*/}}
{{- define "bbw.app.enabledModules" -}}
{{- $mods := list -}}
{{- range $k, $v := .Values.modules -}}
{{- if and $v (ne $k "media") (ne $k "mail") -}}
{{- $mods = append $mods $k -}}
{{- end -}}
{{- end -}}
{{- join "," $mods -}}
{{- end -}}

{{/*
bbw.secretNames：Secret 名称解析（支持 existingSecret 引用/external-secrets 接管）
*/}}
{{- define "bbw.secretName.db" -}}
{{- default "bbw-db" .Values.secrets.existingSecretDb -}}
{{- end -}}

{{- define "bbw.secretName.s3" -}}
{{- default "bbw-s3" .Values.secrets.existingSecretS3 -}}
{{- end -}}

{{- define "bbw.secretName.app" -}}
{{- printf "%s-secrets" (include "bbw.fullname" .) -}}
{{- end -}}
