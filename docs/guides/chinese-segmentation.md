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
| `scripts/embed-wasm.ts` | 构建脚本，将 WASM 文件转 base64 嵌入代码 |
| `src/core/jieba-wasm-embedded.ts` | 自动生成的 WASM base64 数据（约 5MB） |

### 3.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `package.json` | 添加 jieba-wasm 依赖，修改 build 脚本，添加 prebuild |
| `src/core/tokenizer.ts` | 使用内嵌 WASM 初始化 |
| `src/core/pglite-schema.ts` | 新增 segmented_* 列，trigger 改用 'simple' |
| `src/core/pglite-engine.ts` | 写入时分词填充 segmented 列，搜索时分词 |
| `src/core/postgres-engine.ts` | 搜索时分词 |
| `src/core/embedding.ts` | 向量模型改为 bge-m3 |
| `src/core/schema-embedded.ts` | 向量维度改为 1024 |
| `.gitignore` | 添加生成的嵌入文件 |

### 3.3 详细修改

#### 3.3.1 tokenizer.ts（新文件）

```typescript
import init, { cut_for_search } from 'jieba-wasm/web';
import { getJiebaWasmBytes } from './jieba-wasm-embedded';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    const wasmBytes = getJiebaWasmBytes();
    const blob = new Blob([wasmBytes], { type: 'application/wasm' });
    const url = URL.createObjectURL(blob);
    try {
      await init({ module_or_path: url });
    } finally {
      URL.revokeObjectURL(url);
    }
    initialized = true;
  }
}

export async function tokenize(text: string): Promise<string[]> {
  await ensureInitialized();
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

**构建流程**：
1. `prebuild` 脚本自动运行 `scripts/embed-wasm.ts`
2. 将 WASM 文件转为 base64 存入 `src/core/jieba-wasm-embedded.ts`
3. 通过 Blob URL 方式加载内嵌的 WASM bytes
4. `build` 脚本编译时内嵌所有代码，生成自包含二进制

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
    "build": "bun build --compile --outfile bin/gbrain src/cli.ts",
    "build:mac": "bun build --compile --target=bun-darwin-arm64 --outfile bin/gbrain-darwin-arm64 src/cli.ts && bun build --compile --target=bun-darwin-x64 --outfile bin/gbrain-darwin-x64 src/cli.ts",
    "build:win": "bun build --compile --target=bun-windows-x64 --outfile bin/gbrain-windows-x64.exe src/cli.ts",
    "build:all": "bun run build:mac && bun run build:win"
  }
}
```

**注意**：
- 移除了 `--external jieba-wasm`，WASM 文件已内联到代码中
- 添加了跨平台编译脚本

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
```

### 5.2 复制 WASM 文件（自动）

WASM 文件会在构建时自动嵌入到代码中，无需手动复制。

### 5.3 编译

**当前平台：**
```bash
cd ~/gbrain
bun run build
```

**多平台编译：**
```bash
# macOS (arm64 + x64)
bun run build:mac

# Windows (x64)
bun run build:win

# 全部平台
bun run build:all
```

**输出产物：**
```
bin/
├── gbrain              # 当前平台
├── gbrain-darwin-arm64 # macOS Apple Silicon
├── gbrain-darwin-x64   # macOS Intel
└── gbrain-windows-x64.exe # Windows x64
```

**跨平台编译注意**：
- 从 macOS 只能编译 macOS 版本
- 从 Linux 只能编译 Linux 版本
- 从 Windows 只能编译 Windows 版本
- 如需多平台构建，建议使用 CI/CD（如 GitHub Actions）

### 5.4 数据库更新

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

### 7.1 打包问题（已解决）

jieba-wasm 依赖 WASM 文件（约 4MB），之前 bun compile 打包后无法正常工作。

**解决方案**：将 WASM 文件 base64 编码内嵌到代码中。

**新增文件**：`scripts/embed-wasm.ts`
```typescript
import { readFileSync, writeFileSync } from 'fs';

const wasmPath = './node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm';
const outputPath = './src/core/jieba-wasm-embedded.ts';

const wasmBuffer = readFileSync(wasmPath);
const base64 = wasmBuffer.toString('base64');

const content = `export const JIEBA_WASM_BASE64 = "${base64}";

export function getJiebaWasmBytes(): Uint8Array {
  const binaryString = atob(JIEBA_WASM_BASE64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
`;

writeFileSync(outputPath, content);
```

**package.json 修改**：
```json
{
  "scripts": {
    "prebuild": "bun run scripts/embed-wasm.ts",
    "build": "bun build --compile --outfile bin/gbrain src/cli.ts"
  }
}
```

**tokenizer.ts 加载方式**：
```typescript
import { getJiebaWasmBytes } from './jieba-wasm-embedded';

async function ensureInitialized() {
  if (!initialized) {
    const wasmBytes = getJiebaWasmBytes();
    const blob = new Blob([wasmBytes], { type: 'application/wasm' });
    const url = URL.createObjectURL(blob);
    try {
      await init({ module_or_path: url });
    } finally {
      URL.revokeObjectURL(url);
    }
    initialized = true;
  }
}
```

**验证**：
- 二进制大小约 67MB（WASM 内嵌）
- 不需要 `npm link`
- 不依赖外部 node_modules
- 可在任意目录运行

### 7.2 向量维度

如果之前使用 OpenAI embedding (1536维)，切换到 bge-m3 (1024维) 后需要：
1. 修改 schema 中的向量维度
2. 重新生成向量：`gbrain embed --rebuild`

---

## 八、回滚方案

### 8.1 代码回滚

1. 移除生成的嵌入文件：
```bash
rm src/core/jieba-wasm-embedded.ts
rm scripts/embed-wasm.ts  # 如果不再需要
```

2. 恢复 `src/core/tokenizer.ts`（使用外部依赖）：
```typescript
import { cut_for_search } from 'jieba-wasm';

export async function tokenize(text: string): Promise<string[]> {
  return cut_for_search(text, true)
    .filter(w => w.trim() && !/^\p{P}+$/u.test(w));
}
```

3. 恢复 package.json 的 build 脚本：
```json
{
  "scripts": {
    "build": "bun build --compile --outfile bin/gbrain --external jieba-wasm src/cli.ts"
  }
}
```

4. 恢复 .gitignore（移除 `src/core/jieba-wasm-embedded.ts`）

### 8.2 数据库回滚

1. 删除新增列：
```sql
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_title;
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_compiled_truth;
ALTER TABLE pages DROP COLUMN IF EXISTS segmented_timeline;
```

2. 恢复 trigger 函数（改回 'english'）

---

## 九、相关文档

- 详细技术方案：GBrain jieba-wasm + tsvector 中文全文搜索方案
- GBrain 安装配置：GBrain Setup