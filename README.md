# 知返 · 费曼学习助手

一个基于个人资料库的费曼学习助手：上传 PDF、DOCX、TXT 或 Markdown 后，系统会保存原文件、提取知识骨架、建立 pgvector 索引，并通过主动解释、追问、补漏和成果输出帮助用户掌握知识。

## 数据架构

- PostgreSQL：保存项目完整状态、资料元数据和学习事件。
- pgvector：保存每个资料分块的向量。
- 本地文件存储：原始资料保存在 `.data/uploads`。
- 混合检索：pgvector 语义召回与 PostgreSQL 全文关键词召回通过 RRF 合并。
- DeepSeek V4 Pro：负责知识提炼、费曼追问、RAG 最终回答和一页纸生成。

本地默认使用可落盘的 PGlite。它是嵌入式 PostgreSQL，支持 pgvector，不需要用户额外安装数据库；数据保存在 `.data/postgres`。部署时设置 `DATABASE_URL` 即可切换到标准 PostgreSQL。

## 本地运行

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

访问 `http://127.0.0.1:5173`。后端 API 运行在 `http://127.0.0.1:8787`。

没有配置 `DEEPSEEK_API_KEY` 时，持久化、文件存储、分块、向量索引和混合检索仍会真实运行；生成部分使用演示模式。

## 配置 DeepSeek

推荐直接在网页左侧点击“模型设置”，填写 API 地址、模型名称和 API Key，先测试连接再保存。配置保存在本机 PostgreSQL，页面只读取脱敏状态，保存后无需重启。

也可以继续使用环境变量：

```env
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-v4-pro
```

DeepSeek只用于生成，不用于向量化。

## Embedding 配置

默认使用离线轻量特征向量，确保应用开箱即用。如果有 OpenAI 兼容的 Embedding 服务，可配置：

```env
EMBEDDING_BASE_URL=https://你的服务地址/v1
EMBEDDING_API_KEY=你的密钥
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
```

首次建库后不要直接修改 `EMBEDDING_DIMENSIONS`。更换向量维度需要清空并重新建立资料索引。

## 切换到标准 PostgreSQL

服务器需要安装 pgvector 扩展。可以使用仓库提供的 Compose 配置：

```powershell
docker compose up -d postgres
```

然后配置：

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/zhifan
DATABASE_SSL=false
```

应用启动时会自动创建表和索引。

## 持久化目录

```text
.data/
├── postgres/   # 本地嵌入式 PostgreSQL 数据
└── uploads/    # 上传的原始资料
```

备份整个 `.data` 目录即可备份本地资料库。使用标准 PostgreSQL 时，还需要单独备份 PostgreSQL 数据库。

## 测试

```powershell
npm run check
```

测试覆盖：

- PostgreSQL/pgvector 启动与健康检查
- 项目持久化与重新读取
- TXT、Markdown 上传、解析、文件落盘与向量分块
- 向量加关键词的混合检索
- RAG 原文和页码引用
- 费曼教练输入校验与追问
- 一页纸生成
- 生产构建
