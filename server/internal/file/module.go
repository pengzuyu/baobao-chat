// Package file 模块装配（D02 §3 module.go；D06 阶段一务实版）。
package file

import (
	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	fileservice "github.com/baobaowork/server/internal/file/service"
	filestore "github.com/baobaowork/server/internal/file/store"
)

// Module file 模块外壳：对外只暴露 api
type Module struct {
	svc *fileservice.Service
}

// NewModule 装配（存储为本地磁盘实现；对象存储阶段二换 Storage 接口实现即可；
// shares 为分享外链仓储，nil=阶段一形态——share API 返回未装配错误）
func NewModule(opts fileservice.Options, r filerepo.Repo, shares filerepo.ShareRepo, transfers filerepo.TransferRepo, store filestore.Storage) *Module {
	return &Module{svc: fileservice.New(opts, r, shares, transfers, store)}
}

// API 对外服务接口（REST 壳与 message 域校验依赖）
func (m *Module) API() fileapi.FileService { return m.svc }
