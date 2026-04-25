# GBrain 中文搜索改造方案

## 一、改造背景

### 1.1 问题描述

原有 GBrain 关键词搜索使用 `to_tsvector('english', ...)` 配置，英文分词器无法正确处理中文文本，导致：
- 搜索"待办"无法匹配"个人待办"
- 搜索"中文"无法匹配包含"中文"的文档
- 向量搜索（bge-m3）对中文支持较好，但缺少精确匹配能力

### 1.2 改造目标

1. 支持中文全文搜索（精确匹配）
2. 保留向量搜索（语义理解）
3. 实现混合搜索（关键词 + 向量）

---

## 二、改造方案

### 2.1 技术选型

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| zhparser 插件 | 中文分词准确 | PGLite 不支持 | ❌ |
| pg_trgm 模糊匹配 | 安装即用 | 不理解语义 | ❌ |
| **jieba-wasm + tsvector** | PGLite 支持，分词准确 | 需改代码 | ✅ |

### 2.2 架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               写入流程                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  原文 → jieba-wasm cut_for_search() → 分词结果 → 空格拼接                    │
│  → 存入 segmented_* 列 → trigger → to_tsvector('simple') → search_vector   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                               搜索流程                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  查询词 → jieba-wasm cut_for_search() → & 拼接 → to_tsquery('simple')        │
│  → 全文检索 → ts_rank 排序                                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                               混合搜索（保持不变）                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  hybridSearch() → 关键词搜索 + 向量搜索 → RRF 融合                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、代码修改清单

### 3.1 新增文件

| 文件 | 说明 |
|------|------|
| `src/core/tokenizer.ts` | 中文分词模块，使用 jieba-wasm |

### 3.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `package.json` | 添加 jieba-wasm 依赖，修改 build 脚本 |
| `src/core/pglite-schema.ts` | 新增 segmented_* 列，trigger 改用 'simple' |
| `src/core/pglite-engine.ts` | 写入时分词填充 segmented 列，搜索时分词 |
| `src/core/postgres-engine.ts` | 搜索时分词 |
| `src/core/embedding.ts` | 向量模型改为 bge-m3 |
| `src/core/schema-embedded.ts` | 向量维度改为 1024 |

### 3.3 详细修改

#### 3.3.1 tokenizer.ts（新文件）

```typescript
import { cut_for_search } from 'jieba-wasm';

export async function tokenize(text: string): Promise<string[]> {
  return cut_for_search(text, true)
    .filter(w => w.trim() && !/^\p{P}+$/u.test(w));
}

export function toSegmentedText(tokens: string[]): string {
  return tokens.join(' ');
}

export function toTsQueryText(tokens: string[]): string {
  return tokens.filter(w => w.trim()).join(' & ');
}
```

#### 3.3.2 pglite-schema.ts（关键修改）

**新增列：**
```sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_title TEXT DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_compiled_truth TEXT DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_timeline TEXT DEFAULT '';
```

**修改 trigger 函数：**
```sql
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.segmented_title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.segmented_compiled_truth, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.segmented_timeline, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

#### 3.3.3 pglite-engine.ts

**写入时（putPage）：**
```typescript
const titleTokens = await tokenize(page.title || '');
const segmentedTitle = toSegmentedText(titleTokens);
// 写入 INSERT 语句增加 segmented_* 列
```

**搜索时（searchKeyword）：**
```typescript
const tokens = await tokenize(query);
const tsQueryStr = toTsQueryText(tokens);
// 使用 to_tsquery('simple', tsQueryStr) 替代 websearch_to_tsquery('english', query)
```

#### 3.3.4 package.json

```json
{
  "dependencies": {
    "jieba-wasm": "^2.4.0"
  },
  "scripts": {
    "build": "bun build --compile --outfile bin/gbrain --external jieba-wasm src/cli.ts"
  }
}
```

---

## 四、数据库修改

### 4.1 新增列

```sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_title TEXT DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_compiled_truth TEXT DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmented_timeline TEXT DEFAULT '';
```

### 4.2 更新 trigger 函数

```sql
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.segmented_title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.segmented_compiled_truth, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.segmented_timeline, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 4.3 刷新现有数据

```sql
UPDATE pages SET
  search_vector = 
    setweight(to_tsvector('simple', COALESCE(segmented_title, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(segmented_compiled_truth, '')), 'B')
WHERE COALESCE(segmented_title, '') != '' OR COALESCE(segmented_compiled_truth, '') != '';
```

---

## 五、编译与部署

### 5.1 安装依赖

```bash
cd ~/gbrain
bun add jieba-wasm
npm link  # 创建全局链接
```

### 5.2 编译

```bash
cd ~/gbrain
bun run build
```

### 5.3 数据库更新

执行数据库更新脚本（见上方 4.1-4.3）

---

## 六、测试验证

### 6.1 分词测试

```bash
输入: 个人待办事项
分词: ["个人", "待办", "事项"]
拼接: 个人 待办 事项
查询: 个人 & 待办 & 事项
```

### 6.2 搜索测试

| 命令 | 期望结果 |
|------|---------|
| `gbrain search "待办"` | ✅ 匹配 "测试待办" |
| `gbrain search "北京欢迎"` | ✅ 匹配 "北京欢迎" |
| `gbrain search "中文"` | ✅ 匹配包含"中文"的文档 |
| `gbrain query "测试"` | ✅ 混合搜索返回结果 |

---

## 七、已知问题

### 7.1 打包问题

jieba-wasm 依赖 WASM 文件（约 4MB），bun compile 打包后无法正常工作。

**解决方案**：使用 `npm link` 让全局命令从项目目录的 node_modules 加载依赖

```bash
cd ~/gbrain
npm link
```

### 7.2 向量维度

如果之前使用 OpenAI embedding (1536维)，切换到 bge-m3 (1024维) 后需要：
1. 修改 schema 中的向量维度
2. 重新生成向量：`gbrain embed --rebuild`

---

## 八、回滚方案

1. 删除新增列：
```sql
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_title;
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_compiled_truth;
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_timeline;
```

2. 恢复 trigger 函数（改回 'english'）

3. 移除依赖：`bun remove jieba-wasm`

---

## 九、相关文档

- 详细技术方案：GBrain jieba-wasm + tsvector 中文全文搜索方案
- GBrain 安装配置：GBrain Setup