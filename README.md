# compress-img

本地批量图片压缩 CLI，[sharp](https://sharp.pixelplumbing.com) 0.35 驱动。**不联网、无 API key、无次数限制**。

## 功能

- 批量压缩：递归扫描目录，保留子目录结构，默认输出到 `<输入>/compressed`
- 7 种格式互转：jpg / png / webp / avif / tiff / gif（含 heic 解码输入）
- 质量、缩放、居中/偏移裁剪、90° 步进旋转
- 文字水印（字号自适应图宽）与图片水印（支持透明度）
- PNG 自动调色板量化（pngquant 同原理，TinyPNG 的核心压缩策略）
- 渐进式输出、无损模式（webp/avif）、EXIF/GPS 元数据默认清除
- 并发压缩（默认 8）、不覆盖保护、单张失败不中断整批

## 安装

```bash
npm install            # 安装 sharp 依赖
npm link               # 可选：注册全局命令 compress-img
```

## 用法

```bash
node bin/cli.js <文件|目录> [选项]
```

| 选项 | 说明 |
|---|---|
| `-q, --quality <1-100>` | 压缩质量，默认 75；png < 100 时自动调色板量化 |
| `-o, --out <文件>` | 单文件输出路径 |
| `--out-dir <目录>` | 目录模式输出目录（默认 `<输入>/compressed`） |
| `-f, --format <格式>` | 转换格式：jpg png webp avif tiff gif |
| `--resize <WxH>` | 等比缩放到 WxH 以内（不放大） |
| `--crop <WxH[+X+Y]>` | 裁剪；不带偏移则居中 |
| `--rotate <0\|90\|180\|270>` | 旋转（EXIF 方向自动矫正始终开启） |
| `--lossless` | 无损压缩（png 恒定；作用于 jpg/webp/avif） |
| `--progressive` | 渐进式 jpeg/png |
| `--wm-text <文字>` | 文字水印 |
| `--wm-img <图片>` | 图片水印 |
| `--wm-pos <位置>` | 水印位置：northwest…southeast，默认 southeast |
| `--wm-opacity <0-1>` | 水印不透明度，默认 0.6 |
| `--wm-size <px>` | 文字水印字号上限，默认 24（自动随图宽自适应） |
| `--keep-meta` | 保留 EXIF/GPS 元数据（默认清除） |
| `--concurrency <1-64>` | 并发数，默认 8 |
| `--overwrite` | 覆盖已存在的输出 |
| `-h, --help` | 帮助 |

## 示例

```bash
# 压缩整个目录（输出到 ./images/compressed）
compress-img ./images

# 高质量 + 输出到指定目录
compress-img ./images --out-dir ./dist -q 85

# 批量转 webp
compress-img ./photos --format webp --resize 1920x1080

# 压缩单张 + 水印
compress-img photo.jpg -o out.jpg --wm-text "© 2026" --wm-pos southeast

# 居中裁剪 + 无损 avif
compress-img banner.png --crop 1200x600 --format avif --lossless
```

## 实测压缩率（sharp 0.35.4，q75）

| 图片 | 原始 | 压缩后 | 压缩率 |
|---|---|---|---|
| pig-1.jpg（照片） | 21.8 KB | 11.1 KB | -49.3% |
| pig-2.jpg（照片） | 19.3 KB | 9.6 KB | -50.5% |
| a.jpg（噪声测试图） | 659.5 KB | 204.4 KB | -69.0% |
| b.png（噪声测试图） | 264.5 KB | 89.2 KB | -66.3% |

## 编程调用

```js
import { compressImage } from "./lib/compress.js";

const result = await compressImage("input.jpg", {
	output: "output.jpg",
	quality: 80,
	watermark: { text: "© 2026", position: "southeast" },
});
console.log(`省了 ${result.bytesSaved} 字节`);
```

## 测试

```bash
node --test test/compress.test.mjs   # 12 个单元测试
npm test                             # 目录模式 + 组合功能冒烟测试
```

## 从 legacy 迁移

旧脚本（tinify API 版 + sharp 0.29 版）已归档到 `legacy/`。新版对应关系：

| 旧脚本 | 新用法 |
|---|---|
| `legacy/compress-img.js`（tinify 扫目录） | `compress-img <目录>` |
| `legacy/compress.js`（sharp 两轮压缩） | `compress-img <目录> -q 75`（单遍，避免双重有损） |
| `legacy/cli.js`（tinify + HTML 解析） | `compress-img <目录>`（如需 HTML 感知可再提） |
| `legacy/gulpfile.js`（gulp 流水线） | 拆分为独立 CLI，不再依赖 gulp |

## 目录结构

```
bin/cli.js        命令行入口
lib/compress.js   压缩管线（可编程调用）
lib/cli.js        参数解析 / 目录扫描 / 进度输出
lib/util.js       常量与小工具
test/             单元测试 + 冒烟测试
legacy/           归档的旧脚本（2021 年版）
```
