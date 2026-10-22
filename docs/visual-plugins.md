# 可视化插件

在设置中的“可视化插件”分别开关内置效果，或导入 `.json` / `.japviz.json` 文件。全部关闭时保留封面与歌词。七个附加主题与五个专业仪表默认关闭，每个各自有独立开关。停用当前效果后自动回到可用场景。双声道 VU 表显示音量前的 RMS 电平，指针约 300 ms 稳定，峰值保持 1.5 s，0 VU 对应 −18 dBFS。

插件是 GLSL ES 3.0 片段着色器数据，不执行 JavaScript、不访问应用桥接、网络或文件。实时舞台、Android 原生 HDR 和离线视频共用同一份着色器。文件上限 64 KiB，片段上限 32 KiB，最多安装 16 个外部插件；导入时会编译检查，并显示作者及许可供确认。GLSL 本身可以编写昂贵计算，建议控制循环次数和分辨率。

将下面的示例保存为 `soft-glow.japviz.json` 后导入：

```json
{
  "apiVersion": 1,
  "id": "soft-glow",
  "name": "柔光",
  "author": "B5-Software",
  "license": "GPL-3.0-or-later",
  "description": "强调色随低频缓缓浮动",
  "fragment": "vec3 visualize(vec2 uv){vec2 p=screenPoint(uv);float light=exp(-dot(p,p)*5.);return background(uv)+uAccent*light*(.1+uAudio.x*.3); }"
}
```

实现 `vec3 visualize(vec2 uv)`，返回线性 RGB，可超过 1 以保留 HDR 高光；宿主限制在 0–8。不要声明 `main`、版本指令或外部 include。宿主提供：

| 参数 / 函数 | 含义 |
| --- | --- |
| `uRes` | 当前绘制宽高 |
| `uTime` | 音频时间，秒 |
| `uAudio` | 低频、中频、高频、能量 |
| `uAccent` / `uSecond` | 线性强调色与辅助色 |
| `uPointer` | 平滑鼠标或触屏位置 |
| `uView` | 舞台偏移和缩放 |
| `screenPoint(uv)` | 应用比例、偏移与缩放后的舞台坐标 |
| `background(uv)` | 当前封面与主题背景 |
| `studioLight(normal, view, albedo, gloss)` | 内置柔光材质函数 |

插件的作者决定其许可；传播、修改或导出使用第三方插件时，请遵循对应许可。内置四个新效果为本项目原创代码，采用 GPL-3.0-or-later，无外部纹理或商业字体。附加主题已移植为共享的 GPU 着色器，保留各自题材并调整绘制细节；仪表使用参数、频谱历史纹理和静态 OFL 文字刻度，支持相同的 SDR、原生 HDR 与离线导出路径。纹理只在变化时上传，不传输整幅渲染画面。实时、HDR 与导出共用边缘抗锯齿代码，保留大于 1 的线性高光。
