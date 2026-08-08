# 工程 API 鉴权采用 JWT 与后端用户表

工程 API 采用 JWT（access token + refresh token）认证，用户与角色由 io-backend 的 `users` 表统一管理（首启种子 admin），角色沿用 admin/engineer/operator/viewer：admin 与 engineer 可读写删工程，operator 只读，viewer 无工程权限，写操作记审计日志。本轮只把鉴权接到工程 API，但登录、令牌、角色校验中间件按可复用到全部管理 API 的方式设计。选择 JWT 而不是 Session Cookie 是因为编辑器是独立 SPA 跨源访问后端，Bearer 方式最干净；用户数据放后端而不是沿用前端 mock 鉴权，是因为"完善鉴权"必须让身份校验发生在数据所在端。

Status: accepted
