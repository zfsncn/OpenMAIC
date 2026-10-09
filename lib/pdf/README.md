# PDF 解析系统

提供统一接口支持多种文档解析提供商。

## 支持的提供商

### 1. unpdf (内置)

- **成本**: 免费，内置
- **特性**: 基础文本提取、图片提取
- **要求**: 无
- **支持格式**: 仅 PDF

### 2. AliDocMind (阿里云文档智能，LLM 版)

- **成本**: 按量计费（阿里云）
- **特性**:
  - 高级文本提取（保留 Markdown 布局）
  - 表格识别（可输出 HTML 表格）
  - 公式提取
  - 版面分析、OCR
- **要求**:
  - 一对阿里云 AccessKey（AK/SK），或由服务端托管（见下方「凭据来源」）
- **支持格式**: pdf / docx / pptx / xlsx / png / jpeg / bmp / gif
- **说明**: 远程异步任务，解析期间会上报进度，并支持用 job id 续跑

> 系统默认解析器是 AliDocMind；当它不可用（没有凭据）时回落到 `unpdf`。

## 凭据来源

服务端托管优先。在部署的 env-file 中配置：

```bash
ALIDOCMIND_ACCESS_KEY_ID=<AccessKey ID>
ALIDOCMIND_ACCESS_KEY_SECRET=<AccessKey Secret>
# 可选，缺省为 https://docmind-api.cn-hangzhou.aliyuncs.com
ALIDOCMIND_BASE_URL=
```

三者齐备时该 provider 即为**服务端托管**：全部客户端自动可用，并且不需要各自配置。
未托管时，每个用户在「设置 → 模型服务 → PDF」里自填 AK/SK（存浏览器本地）。

## API 使用

```typescript
const formData = new FormData();
formData.append('file', pdfFile);
formData.append('providerId', 'alidocmind');
// 不传 providerId 时按注册表顺序自动选择

const response = await fetch('/api/extract-document', {
  method: 'POST',
  body: formData,
});

const result = await response.json();
// result.data: ParsedPdfContent
```

## 响应格式

```typescript
interface ParsedPdfContent {
  text: string; // 提取的文本（AliDocMind 为 Markdown，图片以 img_N 引用）
  images: string[]; // Base64 图片数组

  // 扩展特性
  tables?: Array<{
    page: number;
    data: string[][];
    caption?: string;
  }>;

  formulas?: Array<{
    page: number;
    latex: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  layout?: Array<{
    page: number;
    type: 'title' | 'text' | 'image' | 'table' | 'formula';
    content: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  metadata?: {
    pageCount: number;
    parser: 'unpdf' | 'alidocmind';
    fileName?: string;
    fileSize?: number;
    processingTime?: number;

    // 用于内容生成流程
    imageMapping?: Record<string, string>; // img_1 -> base64 URL
    pdfImages?: Array<{
      id: string; // img_1, img_2, etc.
      src: string; // base64 data URL
      pageNumber: number; // 页码
      description?: string; // 图片描述
    }>;
  };
}
```

## 与内容生成集成

```typescript
// 1. 解析文档
const parseResult = await parsePDF(
  { providerId: 'alidocmind' },
  buffer,
  { fileName, onProgress, resumeToken },
);

// 2. 提取数据
const pdfText = parseResult.text; // Markdown（含 img_1 引用）
const pdfImages = parseResult.metadata.pdfImages; // 图片数组
const imageMapping = parseResult.metadata.imageMapping; // 图片映射

// 3. 生成场景大纲
await generateSceneOutlinesFromRequirements(
  requirements,
  pdfText,
  pdfImages,
  aiCall,
);

// 4. 生成场景（含图片）
await buildSceneFromOutline(
  outline,
  aiCall,
  stageId,
  assignedImages, // 从 pdfImages 筛选
  imageMapping, // 用于解析 img_1 到实际 URL
);
```

## 图片处理流程

1. **提取**: 文档 → AliDocMind → Markdown + 图片（图片托管在阿里云 OSS）
2. **下载内联**: OSS 签名 URL 会过期，因此按并发上限下载并转为 base64
3. **改写引用**: `![](oss-url)` → `![](img_1)`，下载失败的引用整段移除
4. **映射**: 创建 `{ "img_1": "data:image/png;base64,..." }`
5. **生成**: AI 使用 `img_1` 引用生成幻灯片
6. **解析**: `resolveImageIds()` 替换为实际 URL
7. **渲染**: 幻灯片显示图片

> 只允许抓取 `*.oss-*.aliyuncs.com` 上的图片，单张有大小上限，且禁止重定向 —— 防止把图片下载变成 SSRF 通道。

## 配置

### 全局设置

```typescript
import { useSettingsStore } from '@/lib/store/settings';

useSettingsStore.setState({
  pdfProviderId: 'alidocmind',
  pdfProvidersConfig: {
    alidocmind: {
      accessKeyId: 'LTAI...',
      accessKeySecret: '...',
    },
  },
});
```

## 添加新的提供商

三处必须同步（漏一处会被漂移守卫测试抓出来）：

1. `lib/pdf/types.ts` —— `PDFProviderId` 联合类型
2. `lib/pdf/constants.ts` —— `PDF_PROVIDERS` 注册表（UI 下拉直接由它派生）
3. `lib/document/extractors/manifest.ts` —— 浏览器安全的 manifest 条目（含 `version`）
4. `lib/document/mime.ts` —— `PROVIDER_SUPPORTED_MIME_TYPES` 能力矩阵

再在 `lib/pdf/pdf-providers.ts` 的 `parsePDF()` switch 中实现分派。

> ⚠️ 若抽取出的正文发生变化，必须同步 bump `manifest.ts` 里的 `version` —— 它是派生缓存的
> `extractor_version` 的一半，不 bump 会把旧归档当成同一份内容复用。

## 常见问题

### Q: AliDocMind 认证失败？

**A**: 检查：

1. AK/SK 是否成对且正确（AK 形如 `LTAI...`）
2. 该 RAM 子账号是否具备文档智能 / OSS 所需权限
3. 需要访问外网 `docmind-api.cn-hangzhou.aliyuncs.com` 与 OSS

### Q: 图片不显示？

**A**: 确保：

1. `imageMapping` 正确传递到 scene-stream API
2. 图片 ID 格式正确（img_1, img_2）
3. Base64 编码完整

### Q: unpdf 还是 AliDocMind？

**A**: 选择建议：

| 场景                     | 推荐       |
| ------------------------ | ---------- |
| 简单 PDF（纯文本）       | unpdf      |
| 包含表格、公式、版面     | AliDocMind |
| 需要 OCR                 | AliDocMind |
| 快速测试 / 无凭据环境    | unpdf      |
| 生产环境                 | AliDocMind |

## 参考资源

- **AliDocMind 文档**: https://help.aliyun.com/zh/document-mind/
- **unpdf**: https://github.com/unjs/unpdf

---

**最后更新**: 2026-10-04
**解析器**: unpdf / AliDocMind
**状态**: 生产就绪
