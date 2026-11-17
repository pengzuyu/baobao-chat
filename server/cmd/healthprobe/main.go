// healthprobe 容器健康探针（16 篇 §3.4 镜像清单）。
// bbc-app 为 distroless（无 shell/wget），compose healthcheck 直接 exec 本二进制：
//
//	/healthprobe http://127.0.0.1:8080/healthz
//
// 2xx → exit 0；连接失败/非 2xx → exit 1。静态编译随镜像分发。
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: healthprobe <url>")
		os.Exit(2)
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthprobe: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "healthprobe: %s -> HTTP %d\n", os.Args[1], resp.StatusCode)
		os.Exit(1)
	}
	os.Exit(0)
}
